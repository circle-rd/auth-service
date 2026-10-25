export interface PrintMatrixRole {
  name: string;
  isDefault: boolean;
  permissionCount: number;
}

export interface PrintMatrixRow {
  action: string;
  /** Aligned with `roles`. */
  granted: boolean[];
  roleCount: number;
}

export interface PrintMatrixGroup {
  resource: string;
  rows: PrintMatrixRow[];
}

export interface PrintMatrixData {
  title: string;
  appName: string;
  printedAt: string;
  permissionHeader: string;
  rolesHeader: string;
  defaultLabel: string;
  legend: { granted: string; denied: string };
  roles: PrintMatrixRole[];
  groups: PrintMatrixGroup[];
}

const GRANTED_MARK = '✓';
const DENIED_MARK = '·';
// Beyond this many roles the headers are turned sideways to keep the page width.
const SIDEWAYS_HEADER_THRESHOLD = 6;

const PRINT_CSS = `
  @page { size: landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #111; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  .meta { color: #555; font-size: 9pt; margin-bottom: 5mm; }
  table { border-collapse: collapse; width: 100%; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { border: 0.4pt solid #888; padding: 1.2mm 2mm; text-align: center; }
  th { background: #eee; font-weight: 600; }
  th.corner, td.label { text-align: left; }
  td.label { font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; font-size: 9pt; }
  th.sideways { height: 38mm; vertical-align: bottom; padding: 1.5mm 1mm; }
  th.sideways span { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; }
  tr.group th { background: #f6f6f6; text-align: left; font-family: ui-monospace, Menlo, monospace; }
  td.granted { font-weight: 700; }
  td.denied { color: #999; }
  .legend { margin-top: 4mm; font-size: 9pt; color: #444; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options: { text?: string; className?: string; colSpan?: number } = {},
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  if (options.colSpan && node instanceof HTMLTableCellElement) {
    node.colSpan = options.colSpan;
  }
  return node;
}

function buildTable(doc: Document, data: PrintMatrixData): HTMLTableElement {
  const sideways = data.roles.length > SIDEWAYS_HEADER_THRESHOLD;
  const table = el(doc, 'table');

  const headRow = el(doc, 'tr');
  headRow.append(el(doc, 'th', { text: data.permissionHeader, className: 'corner' }));
  for (const role of data.roles) {
    const label = role.isDefault ? `${role.name} (${data.defaultLabel})` : role.name;
    const th = el(doc, 'th', { className: sideways ? 'sideways' : '' });
    th.append(el(doc, 'span', { text: label }));
    headRow.append(th);
  }
  headRow.append(el(doc, 'th', { text: data.rolesHeader }));
  const thead = el(doc, 'thead');
  thead.append(headRow);
  table.append(thead);

  const body = el(doc, 'tbody');
  for (const group of data.groups) {
    const groupRow = el(doc, 'tr', { className: 'group' });
    groupRow.append(el(doc, 'th', { text: group.resource, colSpan: data.roles.length + 2 }));
    body.append(groupRow);
    for (const row of group.rows) {
      const tr = el(doc, 'tr');
      tr.append(el(doc, 'td', { text: `${group.resource}:${row.action}`, className: 'label' }));
      for (const granted of row.granted) {
        tr.append(
          el(doc, 'td', {
            text: granted ? GRANTED_MARK : DENIED_MARK,
            className: granted ? 'granted' : 'denied',
          }),
        );
      }
      tr.append(el(doc, 'td', { text: String(row.roleCount) }));
      body.append(tr);
    }
  }
  table.append(body);

  const totals = el(doc, 'tr');
  totals.append(el(doc, 'th', { text: data.rolesHeader, className: 'corner' }));
  for (const role of data.roles) totals.append(el(doc, 'th', { text: String(role.permissionCount) }));
  totals.append(el(doc, 'th'));
  const tfoot = el(doc, 'tfoot');
  tfoot.append(totals);
  table.append(tfoot);
  return table;
}

/**
 * Prints the full matrix as a standalone black-and-white document in a hidden
 * frame, so the on-screen theme, filters and sticky layout never reach the page.
 * Every value is inserted as text: role names are user-supplied.
 */
export function printPermissionMatrix(data: PrintMatrixData): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error('Print frame is unavailable');
  }

  doc.title = `${data.title} — ${data.appName}`;
  doc.head.append(el(doc, 'style', { text: PRINT_CSS }));
  doc.body.append(
    el(doc, 'h1', { text: `${data.title} — ${data.appName}` }),
    el(doc, 'div', { text: data.printedAt, className: 'meta' }),
    buildTable(doc, data),
    el(doc, 'div', {
      text: `${GRANTED_MARK} ${data.legend.granted}   ${DENIED_MARK} ${data.legend.denied}`,
      className: 'legend',
    }),
  );

  win.addEventListener('afterprint', () => frame.remove(), { once: true });
  win.focus();
  win.print();
}
