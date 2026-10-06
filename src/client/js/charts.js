const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 680;
const ROW_HEIGHT = 34;
const LABEL_WIDTH = 230;
const VALUE_WIDTH = 116;
const BAR_WIDTH = CHART_WIDTH - LABEL_WIDTH - VALUE_WIDTH - 24;

function createElement(name, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderEmptyChart(container, message) {
  container.replaceChildren();
  const empty = createElement(
    'svg',
    {
      class: 'chart__svg chart__svg--empty',
      viewBox: `0 0 ${CHART_WIDTH} 48`,
      role: 'img',
      'aria-label': message,
      focusable: 'false',
    },
    undefined
  );
  empty.appendChild(
    createElement('text', { x: 0, y: 28, class: 'chart__empty' }, message)
  );
  container.appendChild(empty);
}

export function renderOwnershipChart(container, authors, scopeLabel) {
  const positive = authors
    .filter((author) => author.churn > 0)
    .sort((left, right) => right.churn - left.churn || left.name.localeCompare(right.name))
    .slice(0, 10);

  if (!positive.length) {
    renderEmptyChart(container, `No author churn for ${scopeLabel}.`);
    return;
  }

  const maxValue = positive[0].churn;
  const height = positive.length * ROW_HEIGHT + 16;
  const chart = createElement(
    'svg',
    {
      class: 'chart__svg',
      viewBox: `0 0 ${CHART_WIDTH} ${height}`,
      role: 'img',
      'aria-label': `Horizontal bar chart of author churn share for ${scopeLabel}. Values are listed in the adjacent table.`,
      focusable: 'false',
    },
    undefined
  );

  positive.forEach((author, index) => {
    const top = index * ROW_HEIGHT + 8;
    const barLength = maxValue ? Math.max((author.churn / maxValue) * BAR_WIDTH, 2) : 0;
    const label = `${author.name} <${author.email}>`;
    const group = createElement('g', { class: 'chart__row' }, undefined);

    group.appendChild(
      createElement('title', undefined, `${label}: ${author.churn} churn, ${(author.ownership * 100).toFixed(1)}%`)
    );
    group.appendChild(
      createElement('text', { x: 0, y: top + 16, class: 'chart__label' }, label)
    );
    group.appendChild(
      createElement('rect', {
        class: 'chart__track',
        x: LABEL_WIDTH,
        y: top + 6,
        width: BAR_WIDTH,
        height: 14,
        rx: 4,
      })
    );
    group.appendChild(
      createElement('rect', {
        class: `chart__bar ${index === 0 ? 'chart__bar--primary' : 'chart__bar--secondary'}`,
        x: LABEL_WIDTH,
        y: top + 6,
        width: barLength,
        height: 14,
        rx: 4,
      })
    );
    group.appendChild(
      createElement(
        'text',
        { x: CHART_WIDTH - VALUE_WIDTH, y: top + 16, class: 'chart__value' },
        `${author.churn} · ${(author.ownership * 100).toFixed(1)}%`
      )
    );
    chart.appendChild(group);
  });

  container.replaceChildren(chart);
}
