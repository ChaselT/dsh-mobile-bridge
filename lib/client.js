;(() => {
  function makeFactory() {
    return (require) => {
      const module = { exports: {} };
      const react = require("react");
      const { useState, useEffect } = react;
      const { jsx: h } = require("react/jsx-runtime");

      function Panel() {
        const [state, setState] = useState({ loading: true, uri: "", code: "", error: "" });
        useEffect(() => {
          let alive = true;
          fetch("/mobile/v1/pair/uri")
            .then((r) => r.json())
            .then((j) => {
              if (!alive) return;
              setState({ loading: false, uri: j.uri || "", code: j.code || "", error: "" });
            })
            .catch((e) => {
              if (!alive) return;
              setState({ loading: false, uri: "", code: "", error: String((e && e.message) || e) });
            });
          return () => { alive = false; };
        }, []);

        if (state.loading) return h("div", { style: { padding: 16, color: "#8b9099" } }, "正在取配对信息…");
        if (state.error) return h("div", { style: { padding: 16, color: "#c62828" } }, "读取失败：" + state.error);

        const qr = "https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=6&data=" + encodeURIComponent(state.uri);
        return h("div", { style: { display: "flex", gap: 20, alignItems: "center", padding: 12 } },
          h("img", { src: qr, width: 260, height: 260, style: { borderRadius: 12, background: "#fff", padding: 8, boxShadow: "0 4px 16px rgba(15,23,42,.12)" } }),
          h("div", null,
            h("div", { style: { fontSize: 13, color: "#61666b" } }, "配对码"),
            h("div", { style: { fontSize: 24, fontWeight: 600, letterSpacing: 2, color: "#0f1115" } }, state.code),
            h("div", { style: { fontSize: 12, color: "#8b9099", marginTop: 10, maxWidth: 320, wordBreak: "break-all" } }, state.uri),
            h("div", { style: { fontSize: 12, color: "#8b9099", marginTop: 8 } }, "用 DSH 遥控器 App 扫这个码，10 分钟内有效")
          )
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
