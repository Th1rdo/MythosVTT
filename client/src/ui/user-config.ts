import type { ActorDoc, UserDoc } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { avatar, h, pickFile, upload } from "../dom.ts";
import { closeWindow, openWindow, prompt } from "./windows.ts";

/**
 * A user's own settings (Foundry's User Config): colour, picture, pronouns, character. Players edit
 * themselves and pick among actors they own; the GM edits anyone (name and password too).
 */
export function openUserConfig(userId: string): void {
  const key = `user-${userId}`;
  const u = game.get<UserDoc & { hasPassword?: boolean }>("User", userId);
  if (!u || (!game.isGM && userId !== game.userId)) return;
  const body = openWindow(key, `Utilizador: ${u.name}`, { width: 400 });
  if (!body) return;
  const name = h("input", { value: u.name, disabled: !game.isGM });
  const color = h("input", { type: "color", value: u.color });
  const pronouns = h("input", { value: u.pronouns ?? "", placeholder: "ex.: ela/dela" });
  let avatarSrc = u.avatar ?? null;
  const preview = h("span.user-avatar-preview", null, avatar(avatarSrc, u.name, 64));
  const actors = game.all<ActorDoc>("Actor").filter(a => game.isGM || game.owns(a)).sort((a, b) => a.name.localeCompare(b.name, "pt"));
  const character = h("select", null, h("option", { value: "" }, "— nenhuma —"), actors.map(a => h("option", { value: a._id, selected: u.character === a._id }, a.name)));
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const data: { _id: string } & Record<string, unknown> = { _id: userId, color: color.value, pronouns: pronouns.value.trim(), avatar: avatarSrc, character: character.value || null };
      if (game.isGM) data.name = name.value.trim() || u.name;
      await game.update("User", data);
      closeWindow(key);
    }
  },
    h("div.row", null, preview, h("div.stack.grow", null,
      h("button", {
        type: "button",
        onclick: async () => {
          const file = await pickFile("image/*");
          if (!file) return;
          try {
            avatarSrc = await upload(file);
            preview.replaceChildren(avatar(avatarSrc, u.name, 64));
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }
      }, h("i.fa-solid.fa-image"), " Mudar a imagem"),
      avatarSrc ? h("button", { type: "button", onclick: () => { avatarSrc = null; preview.replaceChildren(avatar(null, u.name, 64)); } }, "Tirar a imagem") : null)),
    h("label.field", null, h("span", null, "Nome"), name),
    h("div.row", null, h("label.field", null, h("span", null, "Cor"), color), h("label.field.grow", null, h("span", null, "Pronomes"), pronouns)),
    h("label.field", null, h("span", null, "Personagem"), character),
    game.isGM ? h("button", {
      type: "button",
      onclick: async () => {
        const v = await prompt(`Palavra-passe de ${u.name}`, [{ name: "password", label: "Nova palavra-passe (vazio = nenhuma)", type: "password" }]);
        if (v) {
          await game.update("User", { _id: userId, password: v.password });
          toast("Palavra-passe mudada", "success");
        }
      }
    }, h("i.fa-solid.fa-key"), u.hasPassword ? " Mudar a palavra-passe" : " Definir palavra-passe") : null,
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Guardar"))));
}
