//#region src/list.ts
const latest = /* @__PURE__ */ new WeakMap();
const List = (props, surface) => {
	const { Box, Text } = surface.elements;
	latest.set(surface, props);
	if (surface.state === void 0) {
		surface.setState({});
		surface.onPointer((ev) => {
			const rows = latest.get(surface)?.rows ?? [];
			const at = ev.y >= 0 && ev.y < rows.length ? ev.y : void 0;
			if (ev.type === "up" && ev.button === "left" && at !== void 0) {
				const row = rows[at];
				if (row) surface.post({
					type: "pick",
					id: row.id
				});
			} else if (ev.type === "move" && surface.state?.hover !== at) surface.setState({ hover: at });
			else if (ev.type === "leave") surface.setState({});
		});
		surface.onKey((k) => {
			const cur = latest.get(surface);
			if (!cur || cur.rows.length === 0) return;
			const key = k.key.toLowerCase();
			const i = cur.rows.findIndex((r) => r.id === cur.picked);
			const step = key === "down" || key === "arrowdown" ? 1 : key === "up" || key === "arrowup" ? -1 : 0;
			if (step === 0) return;
			const next = cur.rows[Math.min(cur.rows.length - 1, Math.max(0, i + step))];
			if (next) surface.post({
				type: "pick",
				id: next.id
			});
		});
	}
	const hover = surface.state?.hover;
	return h(Box, { flexDirection: "column" }, ...props.rows.map((r, i) => {
		const on = r.id === props.picked;
		const lit = !on && i === hover;
		return h(Text, {
			key: `r-${r.id}`,
			inverse: on,
			underline: lit,
			wrap: "truncate-end"
		}, h(Text, {
			color: on ? void 0 : r.tone,
			bold: true
		}, r.strong ? "● " : "  "), h(Text, { dimColor: !on }, `${r.num} `), r.title, " ".repeat(Math.max(0, surface.columns)));
	}));
};

//#endregion
export { List as default };