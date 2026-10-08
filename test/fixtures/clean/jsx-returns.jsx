'use strict';

// Multi-line JSX returned without parentheses: the closing tag sits at the indent of `return`
// and must never be read as dead code.
function Title({ title }) {
  return <h1>
    {title}
  </h1>;
}

function Greeting() {
  return <h1>
    Hello
  </h1>;
}

function Count({ n }) {
  return <p>
    Count: {n}
  </p>;
}

function List({ items }) {
  return <ul className="list">
    {items.map((item) => <li key={item.id}>{item.name}</li>)}
  </ul>;
}

function Wrapper({ children }) {
  return <>
    {children}
  </>;
}

function Card({ onSelect, label }) {
  return <div onClick={() => onSelect(label)} data-label="a > b">
    <span>
      {label}
    </span>
    <Icon name="star" />
  </div>;
}

class Panel {
  render() {
    return <div className="panel">
      {this.props.children}
    </div>;
  }
}

function Empty() {
  return <div
    className="empty"
  />;
}

module.exports = { Title, Greeting, Count, List, Wrapper, Card, Panel, Empty };
