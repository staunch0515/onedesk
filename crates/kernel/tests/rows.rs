//! D487 §27 (docs/redesign/book.md, K15): a table field (`rows`) — its columns checked, its reference columns given
//! choices, its value saved like any field, at most 1000 rows. Temporary folders only; a generic package.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use onedesk_protocol::ErrorCode;
use serde_json::{json, Value};

const MAIN: &str = r#"
export default {
  activate(host) {
    host.pages.handle("slip", {
      render(ctx) {
        const m = (ctx.resource && ctx.resource.body && ctx.resource.body.mode) || "";
        const columns = [
          { name: "item", label: "Item", kind: "ref", kinds: ["thing"] },
          { name: "qty", label: "Qty", kind: "number" },
          { name: "amount", label: "Amount", kind: "number", readOnly: true },
        ];
        if (m === "noColumns") return { view: [{ type: "form", id: "f", layout: "stack", fields: [{ name: "lines", label: "Lines", kind: "rows", bind: "body.lines" }] }] };
        if (m === "badColumn") columns.push({ name: "x", label: "X", kind: "attachment" });
        if (m === "stray") return { view: [{ type: "form", id: "f", layout: "stack", fields: [{ name: "t", label: "T", kind: "text", bind: "body.t", columns }] }] };
        return { view: [{ type: "form", id: "f", layout: "stack", fields: [{ name: "lines", label: "Lines", kind: "rows", bind: "body.lines", columns }] }] };
      },
    });
  },
};
"#;

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let pkg = root.join("test.slip").join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": "test.slip", "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
        "contributes": { "kinds": [
            { "id": "slip", "label": "slip", "icon": "box", "tree": "resources", "draggable": true, "page": "slip" },
            { "id": "thing", "label": "thing", "icon": "box", "tree": "resources", "draggable": true } ],
          "pages": [ { "id": "slip", "actions": [ { "id": "save", "role": "save", "label": "save", "icon": "save" } ] } ] } });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), MAIN).unwrap();
    root
}

async fn create(c: &Client, kind: &str, changes: Value) -> Result<String, onedesk_protocol::ProtocolError> {
    let r = c.call("page.save", json!({ "target": format!("new:{kind}"), "changes": changes })).await?;
    Ok(r["page"]["resourceId"].as_str().unwrap().to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_table_field_is_checked_offers_its_references_and_saves_its_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let root = plugins(tmp.path());
    let env = open_with(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let screw = create(&c, "test.slip:thing", json!({ "name": "Screw" })).await.unwrap();
    let slip = create(&c, "test.slip:slip", json!({ "name": "Slip", "body.lines": [{ "item": screw, "qty": 5 }] })).await.unwrap();
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{slip}") })).await;
    let field = &page["view"][0]["fields"][0];
    assert_eq!(field["kind"], "rows");
    assert_eq!(field["columns"][0]["options"][0], json!({ "value": screw, "label": "Screw" }));
    assert_eq!(page["values"]["body.lines"], json!([{ "item": screw, "qty": 5 }]));
    // Saved like any field; at most 1000 rows.
    let rows: Vec<Value> = (0..1001).map(|i| json!({ "qty": i })).collect();
    let e = c.call("page.save", json!({ "target": format!("resource:{slip}"), "changes": { "body.lines": rows } })).await.unwrap_err();
    assert_eq!((e.code, e.params.get("reason").map(String::as_str)), (ErrorCode::Invalid, Some("tooManyRows")));
    c.ok("page.save", json!({ "target": format!("resource:{slip}"), "changes": { "body.lines": [] } })).await;
    // Columns are checked.
    for mode in ["noColumns", "badColumn", "stray"] {
        let e = create(&c, "test.slip:slip", json!({ "name": mode, "body.mode": mode })).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{mode}");
    }
}
