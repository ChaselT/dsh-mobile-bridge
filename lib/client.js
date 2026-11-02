;(() => {
  function makeFactory() {
    return (require) => {
      const module = { exports: {} };
      const React = require("react");
      const { useState, useEffect, useCallback } = React;
      // 用 createElement：jsx-runtime 的 jsx() 第三参是 key，不是子节点。
      const h = React.createElement;

      const styleLabel = { fontSize: 13, color: "#61666b" };
      const styleInput = {
        flex: 1, padding: "8px 10px", border: "1px solid #e3e5e8",
        borderRadius: 8, fontSize: 13, minWidth: 220
      };
      const stylePrimary = {
        padding: "8px 16px", borderRadius: 8, border: "none",
        background: "#3970e5", color: "#fff", fontSize: 13, cursor: "pointer"
      };

      function MobilePairSection() {
        const [base, setBase] = useState("");
        const [uri, setUri] = useState("");
        const [code, setCode] = useState("");
        const [error, setError] = useState("");
        const [status, setStatus] = useState("");

        const load = useCallback(() => {
          try {
            fetch("/mobile/v1/config")
              .then((r) => r.json())
              .then((j) => setBase(j && j.baseUrl ? j.baseUrl : ""))
              .catch(() => {});
            fetch("/mobile/v1/pair/uri")
              .then((r) => r.json())
              .then((j) => {
                setUri((j && j.uri) || "");
                setCode((j && j.code) || "");
                setError("");
              })
              .catch((e) => setError("取配对信息失败：" + String((e && e.message) || e)));
          } catch (e) {
            setError("初始化失败：" + String((e && e.message) || e));
          }
        }, []);

        useEffect(() => { load(); }, [load]);

        const save = useCallback(() => {
          setStatus("保存中…");
          fetch("/mobile/v1/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseUrl: base })
          })
            .then((r) => r.json())
            .then(() => { setStatus("已保存"); load(); })
            .catch((e) => setStatus("保存失败：" + String((e && e.message) || e)));
        }, [base, load]);

        const qrSrc = uri
          ? "https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=6&data=" + encodeURIComponent(uri)
          : "";

        const row = h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 16 } },
          h("span", { style: styleLabel }, "公网地址"),
          h("input", {
            value: base,
            placeholder: "https://dsh.example.com（留空则用内网地址）",
            onChange: (e) => setBase(e.target.value),
            style: styleInput
          }),
          h("button", { onClick: save, style: stylePrimary }, "保存"),
          status ? h("span", { style: { fontSize: 12, color: "#1a7f37" } }, status) : null
        );

        const body = uri
          ? h("div", { style: { display: "flex", gap: 24, alignItems: "center" } },
              h("img", {
                src: qrSrc, width: 240, height: 240,
                style: { borderRadius: 12, background: "#fff", padding: 8, boxShadow: "0 4px 16px rgba(15,23,42,.12)" }
              }),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
                h("div", { style: styleLabel }, "配对码"),
                h("div", { style: { fontSize: 26, fontWeight: 600, letterSpacing: 3, color: "#0f1115" } }, code),
                h("div", { style: { fontSize: 12, color: "#8b9099", maxWidth: 340, wordBreak: "break-all" } }, uri),
                h("div", { style: { fontSize: 12, color: "#8b9099" } }, "用 DSH 遥控器 App 扫这个码，10 分钟内有效")
              ))
          : h("div", { style: { color: "#8b9099", fontSize: 13 } }, "正在取配对信息…");

        return h("div", { style: { padding: 16, display: "flex", flexDirection: "column" } },
          row,
          error ? h("div", { style: { color: "#c62828", fontSize: 13, marginBottom: 12 } }, error) : null,
          body
        );
      }

      const name = "mobile-bridge";
      const inject = ["slots"];
      function apply(ctx) {
        ctx.slots.inject("settings.section", () => {
          try {
            return ctx.slots.register({
              name: "settings.section",
              id: "mobile-pair",
              order: 60,
              label: () => "手机遥控器"
            }, MobilePairSection);
          } catch (e) {
            return () => {};
          }
        });
      }
      module.exports = { apply, inject, name };
      return module.exports;
    };
  }
  window.__ModuleLoader__.load({ id: "dsh-mobile-bridge", factory: makeFactory() });
})();
