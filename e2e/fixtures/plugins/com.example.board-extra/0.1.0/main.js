// Fixture: example plugin that uses the board plugin's exported tree and page. Kind "memo" lives in
// "com.example.board:board" and is shown by "com.example.board:card"; kind "stray" names the tree "hidden",
// which the board plugin does not export (so it cannot be created). "shout" adds an exclamation mark to a memo.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export function shoutText(text) {
  return `${String(text || "")}!`;
}

export default {
  activate(host) {
    host.kinds.handle("memo", {});
    host.kinds.handle("stray", {});

    host.actions.handle("shout", async (ctx, input) => {
      const res = ctx.resource;
      const text = res && res.body && res.body.text !== undefined ? res.body.text : input && input["body.text"];
      return { output: { type: "text", text: shoutText(text) } };
    });
  },
};
