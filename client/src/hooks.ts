import { HookRegistry } from "../../shared/hooks.ts";

/**
 * The client's hooks (see shared/hooks.ts). Core events fired by Mesa:
 *   init, setup, ready                       startup, in that order (documents are loaded before init)
 *   preCreate<Type>(data, options, userId)   before asking the server; return false to cancel (data may be edited)
 *   preUpdate<Type>(doc, changes, options, userId) · preDelete<Type>(doc, options, userId)
 *   create<Type>(doc, options, userId) · update<Type>(doc, changes, options, userId) · delete<Type>(doc, options, userId)
 *   combatRound / combatTurn(combat, {round, combatantId, previous}) · pauseGame(paused) · userConnected(user, connected)
 *   canvasReady(board) · controlToken(tokenDoc, controlled) · dropCanvasData(board, data) (false = handled)
 *   getSceneControlButtons(groups) · renderWindow(key, body, el) · closeWindow(key)
 *   renderActorSheet(actor, body) · renderChatMessage(message, el) · chatMessage(text, {speaker}) (false = don't send)
 *   hotbarDrop(data, slot) (false = handled) · clientSettingChanged(key, value) · error(hook, err)
 */
export const hooks = new HookRegistry();
