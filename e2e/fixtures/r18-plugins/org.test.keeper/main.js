// e2e probe for run_artifacts (D442): a result-area action that keeps something beside the clicked run.
export default {
  activate(host) {
    host.actions.handle("keep", async (ctx, input) => {
      const runId = String((input && input.runId) || "");
      const made = await ctx.host.runs.saveArtifact(runId, { name: "Kept by test", kind: "note", data: { answer: "ARTIFACT-MARKER", secretish: "none" } });
      const list = await ctx.host.runs.listArtifacts(runId);
      return { output: { type: "text", text: JSON.stringify({ id: made.id, count: list.length }) } };
    });
  },
};
