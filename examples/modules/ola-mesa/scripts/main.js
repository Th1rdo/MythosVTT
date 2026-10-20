// "Olá, Mesa" — an example package. Everything comes from the global `mesa` (see docs/packages.md).
const ID = "ola-mesa";
const { hooks, i18n } = mesa;

function wave(name) {
  const el = document.createElement("div");
  el.className = "ola-wave";
  el.textContent = i18n.format("OLA.Waved", { nome: name });
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

hooks.once("init", () => {
  mesa.settings.register(ID, "greeting", {
    name: i18n.localize("OLA.Greeting"), hint: i18n.localize("OLA.GreetingHint"), scope: "world", type: "boolean", default: true
  });
  mesa.settings.register(ID, "stamp", {
    name: i18n.localize("OLA.Stamp"), hint: i18n.localize("OLA.StampHint"), scope: "client", type: "string", default: "✦"
  });
  mesa.settings.register(ID, "waves", { name: "waves", scope: "world", type: "object", default: { count: 0 } });
  mesa.keybindings.register(ID, "wave", {
    name: i18n.localize("OLA.Wave"), bindings: [{ key: "KeyO", modifiers: ["Shift"] }],
    onDown: () => { sendWave(); return true; }
  });
  mesa.socket.on(ID, (data, userId) => {
    if (data?.type === "wave") wave(mesa.game.get("User", userId)?.name ?? "?");
  });
});

function sendWave() {
  wave(mesa.game.user.name);
  mesa.socket.emit(ID, { type: "wave" });
}

hooks.once("ready", () => {
  if (mesa.settings.get(`${ID}.greeting`)) mesa.toast(i18n.format("OLA.Ready", { nome: mesa.game.user.name }));
});

// A control group of our own on the left bar.
hooks.on("getSceneControlButtons", groups => {
  groups.push({
    name: ID, icon: "fa-solid fa-hand", title: i18n.localize("OLA.Group"), gm: false,
    tools: [
      { name: "wave", icon: "fa-solid fa-hand-sparkles", title: i18n.localize("OLA.Wave"), button: true, run: sendWave },
      {
        name: "mark", icon: "fa-solid fa-tag", title: "Flag", button: true,
        run: async () => {
          const token = mesa.board?.selected[0]?.doc;
          if (!token) return mesa.toast("Seleciona um token");
          const n = (mesa.flags.get(token, ID, "marks") ?? 0) + 1;
          await mesa.flags.set("Token", token, ID, "marks", n);
          mesa.toast(i18n.format("OLA.Counted", { nome: token.name, n }));
        }
      }
    ]
  });
});

hooks.on("renderChatMessage", (message, el) => {
  const stamp = mesa.settings.get(`${ID}.stamp`);
  if (stamp) el.querySelector("header strong")?.append(Object.assign(document.createElement("span"), { className: "ola-stamp", textContent: stamp }));
});
