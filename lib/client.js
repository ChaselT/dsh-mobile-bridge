;(() => {
  function makeFactory() {
    return (require) => {
      const module = { exports: {} };
      const react = require("react");
      const { useState, useEffect } = react;
      const { jsx: h } = require("react/jsx-runtime");

      function Panel() {
        const [state, setState] = useState({ loading: true, uri: "", code: "", error: "" });
        const [base, setBase] = useState("");
        const [saving, setSaving] = useState(false);
        const [saved, setSaved] = useState("");

        const load = () => {
          fetch("/mobile/v1/config")
            .then((r) => r.json())
            .then((j) => setBase(j.baseUrl || ""))
            .catch(() => setBase(""));
          fetch("/mobile/v1/pair/uri")
            .then((r) => r.json())
            .then((j) => setState({ loading: false, uri: j.uri || "", code: j.code || "", error: "" }))
            .catch((e) => setState({ loading: false, uri: "", code: "", error: String((e && e.message) || e) }));
        };

        useEffect(() => { load(); }, []);

        const save = () => {
          setSaving(true);
          setSaved("");
          fetch("/mobile/v1/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseUrl: base })
          })
            .then((r) => r.json())
            .then(() => { setSaved("已保存"); load(); })
            .catch((e) => setSaved("保存失败：" + String((e && e.message) || e)))
            .then(() => setSaving(false));
        };

        const qr = state.uri
          ? "https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=6&data=" + encodeURIComponent(state.uri)
          : "";

        return h("div", { style: { padding: 12 } },
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 14 } },
            h("div", { style: { fontSize: 13, color: "#61666b", width: 90 } }, "公网地址"),
            h("input", {
              value: base,
              placeholder: "https://dsh.example.com（留空则用局域网地址）",
              onChange: (e) => setBase(e.target.value),
              style: { flex: 1, padding: "8px 10px", border: "1px solid #e3e5e8", borderRadius: 8, fontSize: 13 }
            }),
            h("button", {
              onClick: save,
              disabled: saving,
              style: { padding: "8px 16px", borderRadius: 8, border: "none", background: "#3970e5", color: "#fff", fontSize: 13, cursor: "pointer" }
            }, saving ? "保存中…" : "保存"),
            saved ? h("span", { style: { fontSize: 12, color: "#1a7f37" } }, saved) : null
          ),
          state.loading
            ? h("div", { style: { color: "#8b9099" } }, "正在取配对信息…")
            : (state.error
              ? h("div", { style: { color: "#c62828" } }, "读取失败：" + state.error)
              : h("div", { style: { display: "flex", gap: 20, alignItems: "center" } },
                  h("img", { src: qr, width: 260, height: 260, style: { borderRadius: 12, background: "#fff", padding: 8, boxShadow: "0 4px 16px rgba(15,23,42,.12)" } }),
                  h("div", null,
                    h("div", { style: { fontSize: 13, color: "#61666b" } }, "配对码"),
                    h("div", { style: { fontSize: 24, fontWeight: 600, letterSpacing: 2, color: "#0f1115" } }, state.code),
                    h("div", { style: { fontSize: 12, color: "#8b9099", marginTop: 10, maxWidth: 320, wordBreak: "break-all" } }, state.uri),
                    h("div", { style: { fontSize: 12, color: "#8b9099", marginTop: 8 } }, "用 DSH 遥控器 App 扫这个码，10 分钟内有效")
                  )
                ))
        );
      }

      const name = "mobile-bridge";
      const inject = ["slots"];
      function apply(ctx) {
        ctx.slots.inject("settings.section", function* () {
          yield ctx.slots.register({
            name: "settings.section",
            id: "mobile-pair",
            order: 60,
            label: () => "手机遥控器"
          }, Panel);
        });
      }
      module.exports = { apply, inject, name };
      return module.exports;
    };
  }
  window.__ModuleLoader__.load({ id: "dsh-mobile-bridge", factory: makeFactory() });
})();
