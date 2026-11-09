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

// plugins/become-human/behavior-packs/react-page-example/page.tsx
var page_exports = {};
__export(page_exports, {
  contractVersion: () => contractVersion,
  default: () => Page
});
module.exports = __toCommonJS(page_exports);
var import_react = __toESM(require("react"), 1);
var contractVersion = 2;
function Page({ human }) {
  const [count, setCount] = (0, import_react.useState)(null), [same, setSame] = (0, import_react.useState)(false), [busy, setBusy] = (0, import_react.useState)(false), [message, setMessage] = (0, import_react.useState)(""), [crash, setCrash] = (0, import_react.useState)(false);
  const accept = (value) => {
    if (typeof value.count === "number") setCount(value.count);
    if (value.sessionId) setSame(value.sessionId === human.sessionId);
  };
  (0, import_react.useEffect)(() => {
    let live = true;
    human.call("counter.read").then((v) => {
      if (live) accept(v);
    }).catch((e) => {
      if (live) setMessage(e.message);
    });
    return () => {
      live = false;
    };
  }, [human.call]);
  const run = async (method, payload = null) => {
    setBusy(true);
    setMessage("");
    try {
      accept(await human.call(method, payload));
      if (!human.signal.aborted) setMessage("\u64CD\u4F5C\u5B8C\u6210");
    } catch (e) {
      if (!human.signal.aborted) setMessage(e.message);
    } finally {
      if (!human.signal.aborted) setBusy(false);
    }
  };
  if (crash) throw Error("Sample React rendering failure");
  return /* @__PURE__ */ import_react.default.createElement("section", { className: "sample" }, /* @__PURE__ */ import_react.default.createElement("style", null, `.sample{border:1px solid #cbdedc;border-radius:12px;padding:24px;background:#f6fbfa}.sample h2{margin:0 0 12px}.sample output{display:block;font-size:40px;font-weight:600;margin:18px 0}.sample .actions{display:flex;gap:10px;flex-wrap:wrap}.sample button{border:1px solid #b5cfcc;border-radius:7px;background:white;color:#244843}.sample p{overflow-wrap:anywhere}`), /* @__PURE__ */ import_react.default.createElement("h2", null, "React \u8BA1\u6570\u5668"), /* @__PURE__ */ import_react.default.createElement("p", null, same ? "\u5F53\u524D\u4F7F\u7528 Human \u539F\u4F1A\u8BDD" : "\u6B63\u5728\u6838\u5BF9\u4F1A\u8BDD"), /* @__PURE__ */ import_react.default.createElement("output", { "aria-label": "\u793A\u4F8B\u8BA1\u6570" }, count === null ? "\u6B63\u5728\u8BFB\u53D6\u2026" : count), /* @__PURE__ */ import_react.default.createElement("div", { className: "actions" }, /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => run("counter.read") }, "\u5237\u65B0\u8BA1\u6570"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => run("counter.add", { amount: 1 }) }, "\u589E\u52A0\u4E00\u6B21")), /* @__PURE__ */ import_react.default.createElement("p", { role: "status" }, busy ? "\u6B63\u5728\u7B49\u5F85\u64CD\u4F5C\u5B8C\u6210\u2026" : message), /* @__PURE__ */ import_react.default.createElement("details", null, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u9519\u8BEF\u4E0E\u751F\u547D\u5468\u671F\u6F14\u793A"), /* @__PURE__ */ import_react.default.createElement("div", { className: "actions" }, /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => run("sample.error") }, "\u6D4B\u8BD5\u63A5\u53E3\u9519\u8BEF"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => run("sample.slow") }, "\u6D4B\u8BD5\u8D85\u65F6"), /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => setCrash(true) }, "\u6D4B\u8BD5\u9875\u9762\u5F02\u5E38"))), /* @__PURE__ */ import_react.default.createElement("p", null, "\u6B64\u793A\u4F8B\u53EA\u64CD\u4F5C\u81EA\u5DF1\u7684\u8BA1\u6570\u6587\u4EF6\uFF0C\u4E0D\u4FEE\u6539\u4EBA\u683C\u3001\u8BB0\u5FC6\u6216\u804A\u5929\uFF0C\u4E0D\u8C03\u7528\u6A21\u578B\u3002"));
}
