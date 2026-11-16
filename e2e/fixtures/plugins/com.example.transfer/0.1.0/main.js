// Fixture: example "transfer" plugin. Moves content with ctx.host.transfer (download / upload / capture); the content
// never passes through the sandbox. Host errors (denied / conflict / ...) are not caught: they reach the run with code and params.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

export function progressText(ctx, p) {
  const bytes = p && p.bytes !== undefined ? p.bytes : 0;
  return p && p.total !== undefined && p.total !== null ? tr(ctx, "progress.total", { bytes, total: p.total }) : tr(ctx, "progress.line", { bytes });
}

const str = (input, key) => String((input && input[key]) || "");

export default {
  activate(host) {
    host.kinds.handle("job", {});

    host.pages.handle("editor", {
      async render(ctx) {
        const ro = !!ctx.run;
        const withRO = (f) => (ro ? { ...f, readOnly: true } : f);
        return {
          view: [
            { type: "form", id: "url", layout: "stack", fields: [withRO({ name: "url", label: ctx.t("field.url"), kind: "text", bind: "body.url" })] },
            { type: "form", id: "path", layout: "stack", fields: [withRO({ name: "path", label: ctx.t("field.path"), kind: "text", bind: "body.path" })] },
          ],
        };
      },
    });

    host.actions.handle("download", async (ctx, input) => {
      const res = await ctx.host.transfer.download({
        url: str(input, "body.url"),
        to: str(input, "body.path"),
        onProgress: (p) => ctx.progress(0, progressText(ctx, p)),
      });
      return { output: { type: "text", text: tr(ctx, "result.download", { status: res.status, bytes: res.bytes }) }, summary: { message: tr(ctx, "summary.done") } };
    });

    host.actions.handle("upload", async (ctx, input) => {
      const res = await ctx.host.transfer.upload({
        from: str(input, "body.path"),
        url: str(input, "body.url"),
        onProgress: (p) => ctx.progress(0, progressText(ctx, p)),
      });
      return { output: { type: "text", text: tr(ctx, "result.upload", { status: res.status }) }, summary: { message: tr(ctx, "summary.done") } };
    });

    host.actions.handle("capture", async (ctx, input) => {
      const path = str(input, "body.path");
      const res = await ctx.host.transfer.capture({
        program: "cat",
        args: [path],
        to: `${path}.copy`,
        onProgress: (p) => ctx.progress(0, progressText(ctx, p)),
      });
      return { output: { type: "text", text: tr(ctx, "result.capture", { bytes: res.bytes }) }, summary: { message: tr(ctx, "summary.done") } };
    });
  },
};
