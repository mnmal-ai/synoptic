//#region src/todo-text.ts
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
/** Each row is two title lines and a facts line. */
const ROW_LINES = 3;
const PICKED_FILL = "#0a9fdc2e";
const HOVER_FILL = "#8593a81f";
const latest = /* @__PURE__ */ new WeakMap();
const Row = (props, surface) => {
	const { Box, Text } = surface.elements;
	latest.set(surface, props);
	if (surface.state === void 0) {
		surface.setState({});
		surface.onPointer((ev) => {
			const id = latest.get(surface)?.row.id;
			if (ev.type === "up" && ev.button === "left" && id) surface.post({
				type: "pick",
				id
			});
			else if ((ev.type === "move" || ev.type === "enter") && !surface.state?.hover) surface.setState({ hover: true });
			else if (ev.type === "leave") surface.setState({});
		});
		surface.onKey((k) => {
			const key = k.key.toLowerCase();
			const by = key === "down" || key === "arrowdown" ? 1 : key === "up" || key === "arrowup" ? -1 : 0;
			if (by !== 0) surface.post({
				type: "step",
				by
			});
		});
	}
	const r = props.row;
	const on = props.picked;
	const lit = !on && surface.state?.hover === true;
	const width = Math.max(8, surface.columns);
	const flag = (v, k) => v ? { [k]: true } : {};
	const mark = props.tty ? {
		...flag(on, "inverse"),
		...flag(lit, "underline")
	} : {};
	const fill = props.tty ? void 0 : on ? PICKED_FILL : lit ? HOVER_FILL : void 0;
	const lead = `${r.num} `;
	const [first = "", second = ""] = wrapLines(`${lead}${r.title}`, width - 2, 2);
	const t = h;
	const facts = [];
	for (const f of r.facts) {
		const sep = facts.length ? " · " : "";
		if (f.tone) facts.push(sep, t(Text, { color: f.tone }, f.text));
		else facts.push(`${sep}${f.text}`);
	}
	const title = {
		...mark,
		...flag(on, "bold")
	};
	const titleLines = props.tty ? [t(Text, title, t(Text, flag(!on, "dimColor"), first.slice(0, lead.length)), first.slice(lead.length)), t(Text, title, second || " ")] : [t(Box, { height: 2 }, t(Text, {
		...title,
		maxLines: 2
	}, t(Text, flag(!on, "dimColor"), lead), r.title))];
	return t(Box, {
		flexDirection: "column",
		paddingX: 1,
		height: 3,
		...fill ? { backgroundColor: fill } : {}
	}, ...titleLines, t(Text, {
		...mark,
		...flag(!on, "dimColor"),
		wrap: "truncate-end"
	}, ...facts));
};

//#endregion
export { ROW_LINES, Row as default };