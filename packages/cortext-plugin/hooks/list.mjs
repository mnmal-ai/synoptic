//#region src/pane-text.ts
/**
* Text folded into at most `max` lines of `width` characters, breaking at spaces where it can;
* the last line ends in an ellipsis when text is left over.
*/
function wrapLines(text, width, max) {
	const w = Math.max(4, Math.floor(width));
	const words = text.trim().split(/\s+/).filter(Boolean);
	const lines = [];
	let line = "";
	let i = 0;
	while (i < words.length && lines.length < max) {
		const word = words[i] ?? "";
		const next = line ? `${line} ${word}` : word;
		if (next.length <= w) {
			line = next;
			i++;
		} else if (!line) {
			lines.push(word.slice(0, w));
			words[i] = word.slice(w);
		} else {
			lines.push(line);
			line = "";
		}
	}
	if (line && lines.length < max) lines.push(line);
	if (i < words.length && lines.length > 0) {
		const last = lines[lines.length - 1] ?? "";
		lines[lines.length - 1] = `${last.slice(0, w - 1).trimEnd()}…`;
	}
	return lines;
}

//#endregion
//#region src/list.ts
/** Each row is two title lines, a facts line and a gap. */
const ROW_LINES = 4;
/** The most rows drawn at once. */
const MAX_ROWS = 120;
const PICKED_FILL = "#0a9fdc2e";
const HOVER_FILL = "#8593a81f";
const latest = /* @__PURE__ */ new WeakMap();
const List = (props, surface) => {
	const { Box, Text } = surface.elements;
	latest.set(surface, props);
	if (surface.state === void 0) {
		surface.setState({});
		surface.onPointer((ev) => {
			const rows = latest.get(surface)?.rows ?? [];
			const i = Math.floor(ev.y / 4);
			const at = ev.y >= 0 && i < rows.length && ev.y % 4 < 3 ? i : void 0;
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
	const width = Math.max(8, surface.columns);
	const t = h;
	const on = (v, k) => v ? { [k]: true } : {};
	const shown = props.rows.slice(0, 120);
	const rest = props.rows.length - shown.length;
	return t(Box, { flexDirection: "column" }, ...shown.map((r, i) => {
		const picked = r.id === props.picked;
		const lit = !picked && i === hover;
		const mark = props.tty ? {
			...on(picked, "inverse"),
			...on(lit, "underline")
		} : {};
		const fill = props.tty ? void 0 : picked ? PICKED_FILL : lit ? HOVER_FILL : void 0;
		const lead = `${r.num} `;
		const [first = "", second = ""] = wrapLines(`${lead}${r.title}`, width - 2, 2);
		const facts = [];
		for (const f of r.facts) {
			const sep = facts.length ? " · " : "";
			if (f.tone) facts.push(sep, t(Text, { color: f.tone }, f.text));
			else facts.push(`${sep}${f.text}`);
		}
		const title = {
			...mark,
			...on(picked, "bold")
		};
		return t(Box, {
			key: `r-${r.id}`,
			flexDirection: "column",
			paddingX: 1,
			marginBottom: 1,
			...fill ? { backgroundColor: fill } : {}
		}, t(Text, title, t(Text, on(!picked, "dimColor"), first.slice(0, lead.length)), first.slice(lead.length)), t(Text, title, second || " "), t(Text, {
			...mark,
			...on(!picked, "dimColor"),
			wrap: "truncate-end"
		}, ...facts));
	}), ...rest > 0 ? [t(Text, { dimColor: true }, ` ${rest} more. Search or filter to narrow the list.`)] : []);
};

//#endregion
export { MAX_ROWS, ROW_LINES, List as default };