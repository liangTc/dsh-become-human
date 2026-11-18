var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/become-human/behavior-packs/learning/page.tsx
var page_exports = {};
__export(page_exports, {
  contractVersion: () => contractVersion,
  default: () => Page
});
module.exports = __toCommonJS(page_exports);
var import_react = __toESM(require("react"), 1);
var contractVersion = 2;
var errors = { AGENT_BUSY: "Human \u6B63\u5728\u5904\u7406\u6D88\u606F\u6216\u4EFB\u52A1\uFF0C\u8BF7\u7A0D\u540E\u518D\u4FDD\u5B58\u3002", STALE_CONFIGURATION: "\u8BBE\u7F6E\u5DF2\u6709\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u540E\u518D\u4FEE\u6539\u3002", STALE_NOTE: "\u8FD9\u4EFD\u7B14\u8BB0\u5DF2\u6709\u65B0\u7684\u6279\u6CE8\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u3002" };
var format = (at) => new Date(at).toLocaleString();
function Settings({ human, report }) {
  const [base, setBase] = (0, import_react.useState)(null), [value, setValue] = (0, import_react.useState)(null), [busy, setBusy] = (0, import_react.useState)(false);
  const dirty = !!value && JSON.stringify(value) !== JSON.stringify(base?.settings);
  (0, import_react.useEffect)(() => {
    human.setDirty?.(dirty);
    return () => human.setDirty?.(false);
  }, [dirty, human.setDirty]);
  const read = () => human.call("learning.read", { kind: "settings" }).then((r) => {
    setBase(r);
    setValue(r.settings);
  });
  (0, import_react.useEffect)(() => {
    let live = true;
    human.call("learning.read", { kind: "settings" }).then((r) => {
      if (live) {
        setBase(r);
        setValue(r.settings);
      }
    }).catch(report);
    return () => {
      live = false;
    };
  }, [human.call]);
  if (!value) return /* @__PURE__ */ import_react.default.createElement("p", { role: "status" }, "\u6B63\u5728\u8BFB\u53D6\u5B66\u4E60\u8BBE\u7F6E\u2026");
  const patch = (key, v) => setValue((old) => ({ ...old, [key]: v })), mode = !value.learningEnabled ? "off" : value.searchEnabled ? "explore" : "sources";
  return /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("label", null, "\u5B66\u4E60\u65B9\u5F0F", /* @__PURE__ */ import_react.default.createElement("select", { "aria-label": "\u5B66\u4E60\u65B9\u5F0F", value: mode, onChange: (e) => setValue({ ...value, learningEnabled: e.target.value !== "off", searchEnabled: e.target.value === "explore" }) }, /* @__PURE__ */ import_react.default.createElement("option", { value: "off" }, "\u5173\u95ED\u81EA\u4E3B\u5B66\u4E60"), /* @__PURE__ */ import_react.default.createElement("option", { value: "explore" }, "\u6309\u9700\u8981\u63A2\u7D22\u516C\u5F00\u8D44\u6599"), /* @__PURE__ */ import_react.default.createElement("option", { value: "sources" }, "\u53EA\u5173\u6CE8\u6307\u5B9A\u6765\u6E90"))), /* @__PURE__ */ import_react.default.createElement("p", { className: "hint" }, "\u6709\u5177\u4F53\u95EE\u9898\u624D\u5B66\u4E60\u3002\u5B66\u5B8C\u5148\u7559\u7B14\u8BB0\uFF0C\u9002\u5408\u804A\u5929\u65F6\u629B\u4E00\u4E2A\u7B80\u77ED\u5F15\u5B50\uFF1B\u4F60\u8FFD\u95EE\u624D\u5C55\u5F00\uFF0C\u6CA1\u6709\u8FFD\u95EE\u5C31\u51CF\u5C11\u8BE5\u65B9\u5411\u7684\u5206\u4EAB\u3002\u4E3B\u52A8\u8054\u7CFB\u4E0E\u989D\u5EA6\u4ECD\u5728 Human \u8BBE\u7F6E\u4E2D\u7EDF\u4E00\u7BA1\u7406\u3002"), /* @__PURE__ */ import_react.default.createElement("details", null, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u641C\u7D22\u4E0E\u68C0\u67E5\u95F4\u9694"), /* @__PURE__ */ import_react.default.createElement("div", { className: "fields" }, /* @__PURE__ */ import_react.default.createElement("label", null, "\u641C\u7D22\u670D\u52A1", /* @__PURE__ */ import_react.default.createElement("select", { value: value.searchProvider, onChange: (e) => patch("searchProvider", e.target.value) }, /* @__PURE__ */ import_react.default.createElement("option", { value: "bing" }, "Bing \u516C\u5F00\u641C\u7D22"), /* @__PURE__ */ import_react.default.createElement("option", { value: "duckduckgo" }, "DuckDuckGo \u516C\u5F00\u641C\u7D22"), /* @__PURE__ */ import_react.default.createElement("option", { value: "searxng" }, "\u81EA\u6709 SearXNG"))), value.searchProvider === "searxng" && /* @__PURE__ */ import_react.default.createElement("label", null, "\u670D\u52A1\u5730\u5740", /* @__PURE__ */ import_react.default.createElement("input", { value: value.searchEndpoint, onChange: (e) => patch("searchEndpoint", e.target.value), placeholder: "https://search.example.com/" })), /* @__PURE__ */ import_react.default.createElement("label", null, "\u68C0\u67E5\u95F4\u9694\uFF08\u5206\u949F\uFF09", /* @__PURE__ */ import_react.default.createElement("input", { type: "number", min: "10", max: "1440", value: value.sourceIntervalMs / 6e4, onChange: (e) => patch("sourceIntervalMs", Number(e.target.value) * 6e4) }))), /* @__PURE__ */ import_react.default.createElement("p", { className: "hint" }, "\u5230\u65F6\u53EA\u4F1A\u91CD\u65B0\u8003\u8651\u662F\u5426\u503C\u5F97\u5B66\u4E60\uFF0C\u4E0D\u4FDD\u8BC1\u6BCF\u6B21\u6267\u884C\u3002"), /* @__PURE__ */ import_react.default.createElement("label", null, /* @__PURE__ */ import_react.default.createElement("span", null, /* @__PURE__ */ import_react.default.createElement("input", { type: "checkbox", checked: value.goalAutoActivateEnabled, onChange: (e) => patch("goalAutoActivateEnabled", e.target.checked) }), " \u81EA\u52A8\u6FC0\u6D3B\u4F4E\u98CE\u9669\u5B66\u4E60\u76EE\u6807")), /* @__PURE__ */ import_react.default.createElement("p", { className: "hint" }, "\u4EC5\u5F71\u54CD\u5B66\u4E60\u5EFA\u8BAE\uFF0C\u62A5\u544A\u4FDD\u5B58\u7B49\u5199\u64CD\u4F5C\u4ECD\u9700\u5355\u72EC\u6279\u51C6\u3002")), /* @__PURE__ */ import_react.default.createElement("details", { open: mode === "sources" || void 0 }, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u56FA\u5B9A\u5173\u6CE8\u7684\u6765\u6E90 \xB7 ", value.sources.length, " \u9879"), /* @__PURE__ */ import_react.default.createElement("p", { className: "hint" }, "\u53EF\u7559\u7A7A\uFF0C\u6700\u591A 8 \u9879\u3002\u516C\u5F00\u63A2\u7D22\u65F6\u4E0D\u5C40\u9650\u4E8E\u8FD9\u4E9B\u6765\u6E90\u3002"), value.sources.map((source, i) => /* @__PURE__ */ import_react.default.createElement("section", { className: "note", key: i }, /* @__PURE__ */ import_react.default.createElement("div", { className: "row" }, /* @__PURE__ */ import_react.default.createElement("strong", null, "\u6765\u6E90 ", i + 1), /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => patch("sources", value.sources.filter((_, n) => n !== i)) }, "\u79FB\u9664")), [["title", "\u540D\u79F0"], ["url", "\u7F51\u9875\u5730\u5740"], ["topic", "\u5E0C\u671B\u4E86\u89E3\u7684\u95EE\u9898"]].map(([key, label]) => /* @__PURE__ */ import_react.default.createElement("label", { key }, label, /* @__PURE__ */ import_react.default.createElement("input", { value: source[key], onChange: (e) => patch("sources", value.sources.map((v, n) => n === i ? { ...v, [key]: e.target.value } : v)) }))))), /* @__PURE__ */ import_react.default.createElement("button", { disabled: value.sources.length >= 8, onClick: () => patch("sources", [...value.sources, { title: "", url: "", topic: "" }]) }, "\u6DFB\u52A0\u6765\u6E90")), /* @__PURE__ */ import_react.default.createElement("div", { className: "row" }, /* @__PURE__ */ import_react.default.createElement("button", { className: "primary", disabled: !dirty || busy, onClick: async () => {
    setBusy(true);
    try {
      const r = await human.call("learning.save", { operation: "settings", revision: base.revision, settings: value }, `\u5B66\u4E60\u65B9\u5F0F\uFF1A${mode === "off" ? "\u5173\u95ED\u81EA\u4E3B\u5B66\u4E60" : mode === "explore" ? "\u6309\u9700\u8981\u63A2\u7D22\u516C\u5F00\u8D44\u6599" : "\u53EA\u5173\u6CE8\u6307\u5B9A\u6765\u6E90"}
\u68C0\u67E5\u95F4\u9694\uFF1A${value.sourceIntervalMs / 6e4} \u5206\u949F
\u56FA\u5B9A\u6765\u6E90\uFF1A${value.sources.length} \u9879
\u81EA\u52A8\u6FC0\u6D3B\u5B66\u4E60\u76EE\u6807\uFF1A${value.goalAutoActivateEnabled ? "\u5F00\u542F" : "\u5173\u95ED"}`);
      setBase(r);
      setValue(r.settings);
      report(null, "\u5B66\u4E60\u8BBE\u7F6E\u5DF2\u4FDD\u5B58");
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  } }, "\u4FDD\u5B58\u5B66\u4E60\u8BBE\u7F6E"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => {
    if (!dirty || window.confirm("\u653E\u5F03\u5C1A\u672A\u4FDD\u5B58\u7684\u5B66\u4E60\u8BBE\u7F6E\uFF1F")) read().catch(report);
  } }, "\u91CD\u65B0\u8BFB\u53D6")));
}
function Note({ human, note, onClose, report, onSaved }) {
  const [value, setValue] = (0, import_react.useState)(null), [body, setBody] = (0, import_react.useState)(""), [busy, setBusy] = (0, import_react.useState)(false);
  const dirty = !!value && body !== (value.ownerRevision?.summary ?? "");
  (0, import_react.useEffect)(() => {
    human.setDirty?.(dirty);
    return () => human.setDirty?.(false);
  }, [dirty, human.setDirty]);
  (0, import_react.useEffect)(() => {
    let live = true;
    human.call("learning.read", { kind: "note", noteId: note.id }).then((r) => {
      if (live) {
        setValue(r);
        setBody(r.ownerRevision?.summary ?? "");
      }
    }).catch(report);
    return () => {
      live = false;
    };
  }, [human.call, note.id]);
  const save = async (operation, extra) => {
    setBusy(true);
    try {
      const r = await human.call("learning.save", { operation, noteId: note.id, ...extra }, `${value.title}
${operation === "annotate" ? "\u4FDD\u5B58\u4EBA\u5DE5\u6279\u6CE8\uFF1A" + extra.summary : extra.value === "useful" ? "\u53CD\u9988\uFF1A\u5BF9\u6211\u6709\u7528" : extra.value === "not-now" ? "\u53CD\u9988\uFF1A\u6682\u65F6\u4E0D\u60F3\u804A" : "\u7EA0\u6B63\u5E76\u6392\u961F\u91CD\u5B66\uFF1A" + extra.comment}`);
      setValue(r);
      setBody(r.ownerRevision?.summary ?? "");
      onSaved();
      report(null, "\u5DF2\u4FDD\u5B58");
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  if (!value) return /* @__PURE__ */ import_react.default.createElement("p", null, "\u6B63\u5728\u8BFB\u53D6\u7B14\u8BB0\u2026");
  const intent = value.learningIntent;
  return /* @__PURE__ */ import_react.default.createElement("section", { className: "note-detail" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "row sticky" }, /* @__PURE__ */ import_react.default.createElement("h3", null, value.title), /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => {
    if (!dirty || window.confirm("\u653E\u5F03\u5C1A\u672A\u4FDD\u5B58\u7684\u6279\u6CE8\uFF1F")) onClose();
  } }, "\u8FD4\u56DE\u7B14\u8BB0\u5217\u8868")), /* @__PURE__ */ import_react.default.createElement("p", { className: "prose" }, value.summary), value.ownerRevision && /* @__PURE__ */ import_react.default.createElement("aside", null, /* @__PURE__ */ import_react.default.createElement("strong", null, "\u4F60\u7684\u6279\u6CE8"), /* @__PURE__ */ import_react.default.createElement("p", null, value.ownerRevision.summary), /* @__PURE__ */ import_react.default.createElement("small", null, "\u4EBA\u5DE5\u6279\u6CE8\u4FDD\u7559\u539F\u6587\uFF0C\u4E0D\u66FF\u4EE3\u6765\u6E90\u8BC1\u636E\u3002")), intent && /* @__PURE__ */ import_react.default.createElement("details", null, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u4E3A\u4EC0\u4E48\u5B66\u4E60\u8FD9\u4EF6\u4E8B"), [["gap", "\u5F53\u65F6\u7684\u95EE\u9898"], ["selfBenefit", "\u5BF9 Human \u7684\u5E2E\u52A9"], ["userBenefit", "\u5BF9\u4F60\u7684\u53EF\u80FD\u5E2E\u52A9"], ["expectedUse", "\u8BA1\u5212\u600E\u4E48\u7528"]].map(([key, label]) => intent[key] && /* @__PURE__ */ import_react.default.createElement("p", { key }, /* @__PURE__ */ import_react.default.createElement("strong", null, label, "\uFF1A"), intent[key]))), /* @__PURE__ */ import_react.default.createElement("details", null, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u539F\u59CB\u6765\u6E90\u4E0E\u8FD1\u671F\u6279\u6CE8"), value.source?.url && /^https?:\/\//.test(value.source.url) && /* @__PURE__ */ import_react.default.createElement("a", { href: value.source.url, target: "_blank", rel: "noreferrer" }, value.source.title || "\u6253\u5F00\u539F\u59CB\u6765\u6E90", " \u2197"), value.history?.length ? value.history.map((r) => /* @__PURE__ */ import_react.default.createElement("p", { key: r.version }, format(r.changed), " \xB7 ", r.data.summary)) : /* @__PURE__ */ import_react.default.createElement("p", { className: "hint" }, "\u5C1A\u65E0\u4EBA\u5DE5\u6279\u6CE8\u3002")), value.status === "active" ? /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("label", null, "\u6279\u6CE8\u6216\u7EA0\u6B63\u8981\u6C42", /* @__PURE__ */ import_react.default.createElement("textarea", { rows: 4, maxLength: 2e3, value: body, onChange: (e) => setBody(e.target.value), placeholder: "\u53EF\u4EE5\u8865\u5145\u4F60\u7684\u770B\u6CD5\uFF1B\u9700\u8981\u91CD\u65B0\u5B66\u4E60\u65F6\uFF0C\u8BF4\u660E\u54EA\u91CC\u6709\u8BEF\u3002" })), /* @__PURE__ */ import_react.default.createElement("div", { className: "row" }, /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy || !body.trim(), onClick: () => save("annotate", { expectedVersion: value.ownerRevision?.version ?? 0, summary: body }) }, "\u4FDD\u5B58\u6279\u6CE8"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => save("feedback", { value: "useful", comment: body.slice(0, 500) }) }, "\u5BF9\u6211\u6709\u7528"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => save("feedback", { value: "not-now", comment: body.slice(0, 500) }) }, "\u6682\u65F6\u4E0D\u60F3\u804A"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy || !body.trim(), onClick: () => save("feedback", { value: "correction", comment: body.slice(0, 500) }) }, "\u7EA0\u6B63\u5E76\u6392\u961F\u91CD\u5B66"))) : /* @__PURE__ */ import_react.default.createElement("p", { className: "hint" }, "\u8FD9\u4EFD\u7B14\u8BB0\u5DF2\u7ECF\u7EA0\u6B63\u6216\u5F52\u6863\uFF0C\u539F\u8BB0\u5F55\u4FDD\u7559\u4F9B\u67E5\u9605\u3002"));
}
function Notes({ human, report }) {
  const [offset, setOffset] = (0, import_react.useState)(0), [nonce, setNonce] = (0, import_react.useState)(0), [data, setData] = (0, import_react.useState)(null), [note, setNote] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    let live = true;
    human.call("learning.read", { kind: "notes", offset }).then((r) => {
      if (live) setData(r);
    }).catch(report);
    return () => {
      live = false;
    };
  }, [human.call, offset, nonce]);
  if (note) return /* @__PURE__ */ import_react.default.createElement(Note, { ...{ human, note, report }, onClose: () => setNote(null), onSaved: () => setNonce((n) => n + 1) });
  return /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("div", { className: "row" }, /* @__PURE__ */ import_react.default.createElement("p", null, data ? `\u5171 ${data.total} \u4EFD\u7B14\u8BB0` : "\u6B63\u5728\u8BFB\u53D6\u7B14\u8BB0\u2026"), /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => setNonce((n) => n + 1) }, "\u5237\u65B0\u7B14\u8BB0")), data?.items.map((n) => /* @__PURE__ */ import_react.default.createElement("article", { className: "note", key: n.id }, /* @__PURE__ */ import_react.default.createElement("h3", null, n.title), /* @__PURE__ */ import_react.default.createElement("small", null, format(n.created), " \xB7 ", n.status === "active" ? "\u6709\u6548" : "\u5DF2\u7EA0\u6B63 / \u5F52\u6863"), /* @__PURE__ */ import_react.default.createElement("p", null, n.summary), /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => setNote(n) }, "\u67E5\u770B\u7B14\u8BB0\u4E0E\u53CD\u9988"))), data && !data.items.length && /* @__PURE__ */ import_react.default.createElement("p", null, "\u8FD8\u6CA1\u6709\u5B66\u4E60\u7B14\u8BB0\u3002\u6709\u503C\u5F97\u4E86\u89E3\u7684\u95EE\u9898\u65F6\uFF0CHuman \u4F1A\u6309\u8BBE\u7F6E\u8003\u8651\u5B66\u4E60\u3002"), /* @__PURE__ */ import_react.default.createElement("div", { className: "row" }, /* @__PURE__ */ import_react.default.createElement("button", { disabled: !offset, onClick: () => setOffset((n) => Math.max(0, n - 8)) }, "\u4E0A\u4E00\u9875"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: !data || offset + 8 >= data.total, onClick: () => setOffset((n) => n + 8) }, "\u4E0B\u4E00\u9875")));
}
function Page({ human }) {
  const [tab, setTab] = (0, import_react.useState)("settings"), [message, setMessage] = (0, import_react.useState)(""), [error, setError] = (0, import_react.useState)(false);
  const report = (e, text = "") => {
    setError(!!e);
    setMessage(e ? errors[e.message] ?? e.message : text);
  };
  return /* @__PURE__ */ import_react.default.createElement("section", { className: "learning" }, /* @__PURE__ */ import_react.default.createElement("style", null, `.learning{max-width:850px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0}.row h3{flex:1;margin:0}.tabs{border-bottom:1px solid #dae3e8;padding-bottom:12px}.tabs button[aria-selected=true],button.primary{background:#183e50;color:white}button{border:1px solid #b5c6cf;border-radius:8px;background:white}button:disabled{opacity:.5;cursor:default}label{display:flex;flex-direction:column;gap:6px;margin:16px 0;font-weight:600}input,select,textarea{border:1px solid #bdcbd3;border-radius:8px;padding:9px;color:inherit;background:white}details{border-top:1px solid #dae3e8;padding:16px 0}summary{cursor:pointer;font-weight:600}.hint,small{color:#65747d}.note{border:1px solid #dce5e9;border-radius:12px;padding:18px;margin:14px 0}.note p{overflow-wrap:anywhere}article.note p{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.note h3{margin:0 0 6px}.prose{white-space:pre-wrap}.sticky{position:sticky;top:0;background:white;padding:10px 0;z-index:1}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:15px}aside{border-left:3px solid #51818b;padding:4px 15px;background:#f3f8f9}p{overflow-wrap:anywhere}.error{color:#a63832}a{color:#28627c}`), /* @__PURE__ */ import_react.default.createElement("div", { className: "row tabs", role: "tablist", "aria-label": "\u5B66\u4E60\u63D2\u4EF6\u9875\u9762" }, [["settings", "\u5B66\u4E60\u8BBE\u7F6E"], ["notes", "\u5B66\u4E60\u7B14\u8BB0"]].map(([id, label]) => /* @__PURE__ */ import_react.default.createElement("button", { role: "tab", "aria-selected": tab === id, key: id, onClick: () => human.navigate ? human.navigate(() => {
    setTab(id);
    setMessage("");
  }) : setTab(id) }, label))), message && /* @__PURE__ */ import_react.default.createElement("p", { role: error ? "alert" : "status", className: error ? "error" : "" }, message), tab === "settings" ? /* @__PURE__ */ import_react.default.createElement(Settings, { ...{ human, report } }) : /* @__PURE__ */ import_react.default.createElement(Notes, { ...{ human, report } }));
}
