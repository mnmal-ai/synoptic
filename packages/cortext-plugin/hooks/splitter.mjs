//#region src/splitter.ts
const Splitter = (props, surface) => {
	const { Box, Text } = surface.elements;
	if (surface.state === void 0) {
		surface.setState({});
		surface.onPointer((ev) => {
			const last = surface.state?.last;
			if (ev.type === "down" && ev.button === "left") surface.setState({ last: ev.x });
			else if (ev.type === "move" && ev.button === "left" && last !== void 0) {
				const delta = ev.x - last;
				if (delta === 0) return;
				surface.post({
					type: "split",
					delta
				});
				surface.setState({ last: ev.x - delta });
			} else if (ev.type === "up") surface.setState({});
		});
		surface.onKey((k) => {
			const key = k.key.toLowerCase();
			if (key === "left" || key === "arrowleft") surface.post({
				type: "split",
				delta: -2
			});
			if (key === "right" || key === "arrowright") surface.post({
				type: "split",
				delta: 2
			});
		});
	}
	const dragging = surface.state?.last !== void 0;
	const rows = Math.max(1, Math.min(200, props.rows));
	const line = h(Text, { color: dragging ? props.accent ?? "suggestion" : props.rule ?? "promptBorder" }, Array(rows).fill("│").join("\n"));
	return h(Box, {
		flexDirection: "column",
		width: 1
	}, line);
};

//#endregion
export { Splitter as default };