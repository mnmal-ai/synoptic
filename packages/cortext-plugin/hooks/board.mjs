//#region src/board.ts
const CARD_ROWS = 5;
const HEAD_ROWS = 2;
const GAP = 2;
/** The lane and card under a cell, for a board drawn `columns` wide. */
function hitTest(lanes, columns, x, y) {
	const n = Math.max(1, lanes.length);
	const width = Math.max(8, Math.floor((columns - GAP * (n - 1)) / n));
	const lane = Math.min(n - 1, Math.max(0, Math.floor(x / (width + GAP))));
	const row = y - 2;
	const index = row >= 0 ? Math.floor(row / 5) : -1;
	const cards = lanes[lane]?.cards ?? [];
	return {
		lane,
		card: index >= 0 && index < cards.length ? index : void 0
	};
}
const latest = /* @__PURE__ */ new WeakMap();
const Board = (props, surface) => {
	const { Box, Text } = surface.elements;
	latest.set(surface, props);
	const lanes = props.lanes;
	const st = surface.state ?? {};
	if (surface.state === void 0) {
		surface.setState({});
		surface.onPointer((ev) => {
			const now = surface.state ?? {};
			const cur = latest.get(surface)?.lanes ?? [];
			const at = hitTest(cur, surface.columns, ev.x, ev.y);
			const cardAt = at.card === void 0 ? void 0 : cur[at.lane]?.cards[at.card];
			if (ev.type === "down" && ev.button === "left" && cardAt) surface.setState({
				...now,
				drag: {
					id: cardAt.id,
					from: at.lane,
					x: ev.x,
					y: ev.y,
					moved: false
				},
				over: at.lane
			});
			else if (ev.type === "move" && now.drag) {
				const moved = now.drag.moved || Math.abs(ev.x - now.drag.x) + Math.abs(ev.y - now.drag.y) > 1;
				surface.setState({
					...now,
					drag: {
						...now.drag,
						moved
					},
					over: at.lane
				});
			} else if (ev.type === "move") {
				if (now.hover !== cardAt?.id) surface.setState({
					...now,
					hover: cardAt?.id
				});
			} else if (ev.type === "up" && now.drag) {
				const d = now.drag;
				if (!d.moved) surface.post({
					type: "open",
					id: d.id
				});
				else if (at.lane !== d.from) {
					const status = cur[at.lane]?.status;
					if (status) surface.post({
						type: "move",
						id: d.id,
						status
					});
				}
				surface.setState({ hover: now.hover });
			} else if (ev.type === "leave") surface.setState({});
		});
	}
	const n = Math.max(1, lanes.length);
	const width = Math.max(8, Math.floor((surface.columns - GAP * (n - 1)) / n));
	const dragging = st.drag?.moved ? st.drag : void 0;
	const cardEl = (c) => {
		const lifted = dragging?.id === c.id;
		const lit = c.id === props.picked || c.id === st.hover;
		return h(Box, {
			key: `c-${c.id}`,
			flexDirection: "column",
			width,
			height: 5,
			borderStyle: "round",
			borderColor: lifted ? "subtle" : lit ? "suggestion" : "promptBorder",
			paddingX: 1
		}, h(Text, {
			bold: c.strong,
			dimColor: lifted,
			wrap: "truncate-end"
		}, c.title), h(Text, {
			color: "subtle",
			wrap: "truncate-end"
		}, c.meta), h(Text, {
			color: "suggestion",
			wrap: "truncate-end"
		}, c.tags || " "));
	};
	return h(Box, {
		flexDirection: "row",
		gap: GAP
	}, ...lanes.map((lane, i) => {
		const target = dragging !== void 0 && st.over === i && i !== dragging.from;
		return h(Box, {
			key: `l-${lane.status}`,
			flexDirection: "column",
			width
		}, h(Text, {
			bold: true,
			color: lane.tone,
			underline: target,
			wrap: "truncate-end"
		}, `${lane.title} ${lane.cards.length}${target ? "  · drop here" : ""}`), h(Text, {}, " "), ...lane.cards.length === 0 ? [h(Text, { color: "subtle" }, target ? "" : "Empty")] : lane.cards.map(cardEl));
	}));
};

//#endregion
export { CARD_ROWS, HEAD_ROWS, Board as default, hitTest };