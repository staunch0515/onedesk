//! Round 10: field merge of a stale `page.save` (D374), type-supplied children (D375), start-up
//! with very many packages (§7). Temporary folders only.

mod common;

use common::*;
use onedesk_protocol::{ErrorCode, ProtocolError};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

fn db(env: &Env) -> Connection {
    Connection::open_with_flags(env.kernel.db_path(), OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap()
}

async fn setup() -> (Env, Client) {
    let env = open(&fixtures());
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn new_item(c: &Client) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.alpha:item", "changes": { "body.text": "a", "body.extra": 1, "tags": ["x"] } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn save(c: &Client, id: &str, changes: Value, basis: &str) -> Result<Value, ProtocolError> {
    c.call("page.save", json!({ "target": format!("resource:{id}"), "changes": changes, "basis": basis })).await
}

async fn get(c: &Client, id: &str) -> Value {
    c.ok("resource.get", json!({ "id": id })).await
}

fn stale(e: &ProtocolError) -> (ErrorCode, &str, &str, &str) {
    (e.code, e.params["reason"].as_str(), e.params["fields"].as_str(), e.params["rev"].as_str())
}

/* ------------------------------------------------------------------ §4 merge */

#[tokio::test(flavor = "multi_thread")]
async fn stale_basis_without_overlap_saves_and_keeps_the_other_change() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    // Elsewhere: the name (rev 2) and a body field (rev 3).
    save(&c, &id, json!({ "name": "elsewhere" }), "1").await.unwrap();
    save(&c, &id, json!({ "body.extra": 2 }), "2").await.unwrap();
    // This editor is still on rev 1 and changed only the text.
    let r = save(&c, &id, json!({ "body.text": "mine" }), "1").await.unwrap();
    assert_eq!(r["page"]["basis"], "4");
    let res = get(&c, &id).await;
    assert_eq!((res["name"].as_str(), res["body"]["text"].as_str(), res["body"]["extra"].as_i64()), (Some("elsewhere"), Some("mine"), Some(2)));
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_basis_with_overlap_is_refused_listing_the_fields_and_the_rev() {
    let (env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "elsewhere", "tags": ["y"], "body.text": "theirs" }), "1").await.unwrap();
    let e = save(&c, &id, json!({ "name": "mine", "tags": ["z"], "body.text": "mine", "description": "d" }), "1").await.unwrap_err();
    let (code, reason, fields, rev) = stale(&e);
    assert_eq!((code, reason, rev), (ErrorCode::Conflict, "stale", "2"));
    let mut f: Vec<&str> = fields.split(',').collect();
    f.sort();
    assert_eq!(f, vec!["body.text", "name", "tags"]);
    // Nothing written, not even the free `description`.
    let res = get(&c, &id).await;
    assert_eq!((res["name"].as_str(), res["description"].as_str(), res["body"]["text"].as_str()), (Some("elsewhere"), Some(""), Some("theirs")));
    let n: i64 = db(&env).query_row("SELECT count(*) FROM revisions WHERE resource_id = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_kind_of_field_conflicts_on_its_own() {
    let (_env, c) = setup().await;
    for (theirs, mine, field) in [
        (json!({ "name": "t" }), json!({ "name": "m" }), "name"),
        (json!({ "tags": ["t"] }), json!({ "tags": ["m"] }), "tags"),
        (json!({ "body.text": "t" }), json!({ "body.text": "m" }), "body.text"),
        (json!({ "body.new": "t" }), json!({ "body.new": "m" }), "body.new"),
        (json!({ "body.extra": null }), json!({ "body.extra": 5 }), "body.extra"),
    ] {
        let id = new_item(&c).await;
        save(&c, &id, theirs, "1").await.unwrap();
        let e = save(&c, &id, mine.clone(), "1").await.unwrap_err();
        assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", field, "2"), "{field}");
        // A different body field next to it is not a conflict.
        save(&c, &id, json!({ "body.other": 1 }), "1").await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn overwrite_keeps_mine_for_the_named_fields_only() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "theirs", "body.text": "theirs" }), "1").await.unwrap();
    let t = format!("resource:{id}");
    // Only one of the two clashing fields named: still refused, for the other one.
    let e = c
        .call("page.save", json!({ "target": t, "changes": { "name": "mine", "body.text": "mine" }, "basis": "1", "overwrite": ["name"] }))
        .await
        .unwrap_err();
    assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", "body.text", "2"));
    // Both named: written.
    c.ok("page.save", json!({ "target": t, "changes": { "name": "mine", "body.text": "mine" }, "basis": "1", "overwrite": ["name", "body.text"] }))
        .await;
    let res = get(&c, &id).await;
    assert_eq!((res["name"].as_str(), res["body"]["text"].as_str()), (Some("mine"), Some("mine")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_basis_gone_from_the_history_counts_every_field_as_changed() {
    let (env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "theirs" }), "1").await.unwrap();
    db(&env).execute("DELETE FROM revisions WHERE resource_id = ?1 AND rev = 1", [&id]).unwrap();
    let e = save(&c, &id, json!({ "body.text": "mine" }), "1").await.unwrap_err();
    assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", "body.text", "2"));
    // "Keep mine" still gets through.
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.text": "mine" }, "basis": "1", "overwrite": ["body.text"] }))
        .await;
    assert_eq!(get(&c, &id).await["body"]["text"], "mine");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_current_basis_or_none_behaves_as_before() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "one" }), "1").await.unwrap();
    // Current basis: the same field again is fine.
    save(&c, &id, json!({ "name": "two" }), "2").await.unwrap();
    // No basis at all: written without any check.
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "name": "three" } })).await;
    assert_eq!(get(&c, &id).await["name"], "three");
    // A field changed and changed back since the basis is not a conflict (compared by value).
    save(&c, &id, json!({ "body.text": "b" }), "4").await.unwrap();
    save(&c, &id, json!({ "body.text": "a" }), "5").await.unwrap();
    save(&c, &id, json!({ "body.text": "mine" }), "4").await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn plugin_writes_keep_their_rules() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "body.text": "user" }), "1").await.unwrap();
    // Without a basis a plugin write simply applies.
    let r = c.probe("test.alpha", "resources.update", json!([id, { "body.text": "plugin" }])).await;
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(get(&c, &id).await["body"]["text"], "plugin");
    // An editor that was on rev 2 and changed the same field is now refused.
    let e = save(&c, &id, json!({ "body.text": "mine" }), "2").await.unwrap_err();
    assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", "body.text", "3"));
}
