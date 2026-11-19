/* =========================================================
   ARENAS GRILL & BAR — Sincronización con Supabase
   Guarda el menú completo en la tabla menu_prices usando la
   clave reservada __menu_state__. La lectura es pública; la
   escritura requiere sesión autenticada del dueño.
   ========================================================= */
(function () {
  "use strict";

  var config = window.ARENAS_CONFIG || {};
  var base = String(config.supabaseUrl || "").replace(/\/$/, "");
  var anon = String(config.supabaseAnonKey || "");
  var SESSION_KEY = "arenas.cloud.session";
  var MENU_KEY = "__menu_state__";

  function enabled() {
    return Boolean(base && anon);
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch (err) {
      return null;
    }
  }

  var session = readSession();

  function saveSession(next) {
    session = next;
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* almacenamiento no disponible */
    }
  }

  function authRequest(path, body) {
    return fetch(base + "/auth/v1/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anon },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error(data.error_description || data.msg || data.error || "No se pudo iniciar sesión.");
        }
        return data;
      });
    });
  }

  function toSession(data) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      email: (data.user && data.user.email) || ""
    };
  }

  function signIn(email, password) {
    return authRequest("token?grant_type=password", { email: email, password: password }).then(function (data) {
      var next = toSession(data);
      saveSession(next);
      return next;
    });
  }

  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(new Error("Sesión expirada."));
    return authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token }).then(function (data) {
      var next = toSession(data);
      saveSession(next);
      return next;
    });
  }

  function signOut() {
    var current = session;
    saveSession(null);
    if (current && current.access_token) {
      fetch(base + "/auth/v1/logout", {
        method: "POST",
        headers: { apikey: anon, Authorization: "Bearer " + current.access_token }
      }).catch(function () {});
    }
  }

  function withAuth() {
    if (session && session.expires_at - 60000 > Date.now()) return Promise.resolve(session);
    return refresh();
  }

  function rest(path, options) {
    options = options || {};
    return withAuth().then(function (current) {
      return fetch(base + "/rest/v1/" + path, {
        method: options.method || "GET",
        headers: {
          apikey: anon,
          Authorization: "Bearer " + current.access_token,
          "Content-Type": "application/json",
          Prefer: options.prefer || "return=minimal"
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      }).then(function (res) {
        if (res.status === 401) {
          saveSession(null);
          throw new Error("La sesión expiró. Vuelve a entrar.");
        }
        if (!res.ok) {
          return res.text().then(function (text) {
            throw new Error("Supabase (" + res.status + "): " + text.slice(0, 160));
          });
        }
        return options.method && options.method !== "GET" ? null : res.json();
      });
    });
  }

  function load() {
    if (!enabled()) return Promise.resolve(null);
    var url =
      base +
      "/rest/v1/menu_prices?key=eq." +
      encodeURIComponent(MENU_KEY) +
      "&select=options,updated_at&limit=1";
    return fetch(url, { headers: { apikey: anon } })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) return null;
        var row = rows[0];
        var data = row.options && row.options.state ? row.options.state : null;
        if (!data || !data.business || !Array.isArray(data.products)) return null;
        return { state: data, updatedAt: row.updated_at || "" };
      })
      .catch(function () {
        return null;
      });
  }

  /* Consulta muy liviana: solo la marca de tiempo del menú publicado.
     Sirve para no descargar el menú completo cuando no ha cambiado. */
  function revision() {
    if (!enabled()) return Promise.resolve(null);
    var url =
      base +
      "/rest/v1/menu_prices?key=eq." +
      encodeURIComponent(MENU_KEY) +
      "&select=updated_at&limit=1";
    return fetch(url, { headers: { apikey: anon }, cache: "no-store" })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows)) return null;
        if (!rows.length) return "__none__";
        return rows[0].updated_at || "";
      })
      .catch(function () {
        return null;
      });
  }

  /* Canal de avisos para las demás pestañas del mismo dispositivo:
     cuando el panel publica un cambio, la carta abierta se refresca al
     instante en vez de esperar el siguiente sondeo. */
  var CHANNEL = "arenas-menu-live";
  var channel = null;
  var listeners = [];

  function bus() {
    if (channel !== null) return channel;
    try {
      channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : false;
    } catch (err) {
      channel = false;
    }
    if (channel) {
      channel.onmessage = function () {
        listeners.forEach(function (fn) {
          try {
            fn();
          } catch (err) {
            /* un oyente falló, los demás siguen */
          }
        });
      };
    }
    return channel;
  }

  function onChange(fn) {
    if (typeof fn !== "function") return;
    listeners.push(fn);
    bus();
    /* Respaldo para navegadores sin BroadcastChannel. */
    if (listeners.length === 1) {
      window.addEventListener("storage", function (event) {
        if (event.key !== CHANNEL + ":stamp") return;
        listeners.forEach(function (item) {
          try {
            item();
          } catch (err) {
            /* ignorado */
          }
        });
      });
    }
  }

  function notifyChange() {
    /* Aviso por el canal en vivo, además del aviso local entre pestañas. */
    if (socket && socket.readyState === 1) {
      sendBroadcast();
    } else if (!blocked) {
      pendingBroadcast = true;
      connect();
    }
    var stamp = String(Date.now());
    var busChannel = bus();
    if (busChannel) {
      try {
        busChannel.postMessage({ at: stamp });
      } catch (err) {
        /* sin canal disponible */
      }
    }
    try {
      localStorage.setItem(CHANNEL + ":stamp", stamp);
    } catch (err) {
      /* almacenamiento no disponible */
    }
  }

  function save(state) {
    if (!enabled()) return Promise.reject(new Error("Supabase no está configurado."));
    return rest("menu_prices?on_conflict=key", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [{ key: MENU_KEY, price: null, options: { state: state } }]
    });
  }

  /* ---------------- Canal en vivo (Supabase Realtime) ----------------
     Abre un WebSocket contra Realtime y avisa al instante cuando la fila
     del menú cambia. Si la red o la CSP lo impiden, se abandona sin
     romper nada: el sondeo periódico sigue funcionando como respaldo. */
  var live = false;
  var socket = null;
  var ref = 0;
  var retry = null;
  var heartbeat = null;
  var backoff = 1500;
  var blocked = false;
  var failures = 0;
  var pendingBroadcast = false;
  var lastAnnounce = 0;
  var TOPIC = "realtime:arenas-menu";

  function wsUrl() {
    return base.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + encodeURIComponent(anon) + "&vsn=1.0.0";
  }

  function push(message) {
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      /* socket cerrado a medio envío */
    }
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function announce() {
    /* Freno simple: un aviso repetido en el mismo segundo no aporta. */
    var now = Date.now();
    if (now - lastAnnounce < 1200) return;
    lastAnnounce = now;
    live = true;
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (err) {
        /* un oyente falló, los demás siguen */
      }
    });
  }

  function sendBroadcast() {
    if (!socket || socket.readyState !== 1) return;
    ref += 1;
    push({
      topic: TOPIC,
      event: "broadcast",
      payload: { type: "broadcast", event: "menu-updated", payload: { at: Date.now() } },
      ref: String(ref)
    });
  }

  function shutdown() {
    stopHeartbeat();
    if (retry) clearTimeout(retry);
    retry = null;
    var current = socket;
    socket = null;
    live = false;
    if (current) {
      try {
        current.onclose = null;
        current.close();
      } catch (err) {
        /* ya estaba cerrado */
      }
    }
  }

  function retryLater() {
    if (blocked || retry || document.hidden) return;
    retry = setTimeout(function () {
      retry = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  function connect() {
    if (socket && socket.readyState <= 1) return;
    if (socket) {
      try {
        socket.close();
      } catch (err) {
        /* ya estaba cerrado */
      }
      socket = null;
    }
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    try {
      socket = new WebSocket(wsUrl());
    } catch (err) {
      blocked = true;
      socket = null;
      return;
    }

    socket.onopen = function () {
      backoff = 1500;
      failures = 0;
      ref += 1;
      push({
        topic: TOPIC,
        event: "phx_join",
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: "" },
            private: false
          }
        },
        ref: String(ref),
        join_ref: String(ref)
      });
      stopHeartbeat();
      heartbeat = setInterval(function () {
        ref += 1;
        push({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref) });
      }, 25000);
    };

    socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message.event === "broadcast") {
        if (message.payload && message.payload.event === "menu-updated") announce();
      } else if (message.event === "postgres_changes") {
        announce();
      } else if (message.event === "phx_reply" && message.payload) {
        if (message.payload.status === "ok") {
          live = true;
          if (pendingBroadcast) {
            pendingBroadcast = false;
            sendBroadcast();
          }
        } else if (message.topic === TOPIC) {
          /* Suscripción rechazada: se deja el sondeo como respaldo. */
          live = false;
          shutdown();
          blocked = true;
        }
      }
    };

    socket.onclose = function () {
      stopHeartbeat();
      socket = null;
      live = false;
      failures += 1;
      /* Tras varios intentos fallidos se deja de insistir (red o CSP) y
         el sondeo periódico se encarga de mantener el menú al día. */
      if (failures >= 4) {
        blocked = true;
        return;
      }
      retryLater();
    };

    socket.onerror = function () {
      /* Si el navegador no permite el WebSocket (CSP), no insistir. */
      if (!socket || socket.readyState === 3) return;
    };
  }

  function realtime(onChange) {
    if (!enabled() || !("WebSocket" in window)) return;
    if (typeof onChange === "function") listeners.push(onChange);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) shutdown();
      else connect();
    });
    window.addEventListener("online", connect);
    connect();
  }

  window.ArenasCloud = {
    enabled: enabled,
    load: load,
    revision: revision,
    save: save,
    signIn: signIn,
    signOut: signOut,
    notifyChange: notifyChange,
    onChange: onChange,
    realtime: realtime,
    live: function () {
      return live;
    },
    session: function () {
      return session;
    }
  };
})();
