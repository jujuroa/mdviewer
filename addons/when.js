// `when` conditions on add-on menus and keybindings (protocol 12.3):
// `key`, `!key`, `key == 'value'`, `key != 'value'`, `&&`, `||` and
// parentheses. Keys are looked up when the condition is evaluated, so a
// key like `projectHas.<name>` can be worked out only when asked. Pure.

const TOKEN = /\s*(\(|\)|&&|\|\||==|!=|!|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.\-]+)/y;

function tokenize(text) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    if (!m) throw new SyntaxError(`Unexpected "${text.slice(at).trim()[0]}" at ${at}`);
    tokens.push(m[1]);
    at = TOKEN.lastIndex;
  }
  return tokens;
}

// The condition as a tree: { or: [...] } | { and: [...] } | { not } |
// { key, op?, value? }. Throws SyntaxError on a malformed one.
function parseWhen(text) {
  const tokens = tokenize(String(text));
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => {
    if (tokens[i] !== t) throw new SyntaxError(`Expected "${t}"`);
    i++;
  };
  const isWord = (t) => t !== undefined && /^[A-Za-z0-9_.\-]+$/.test(t);
  const literal = (t) => {
    if (t === undefined) throw new SyntaxError('Missing value');
    if (/^['"]/.test(t)) return t.slice(1, -1).replace(/\\(.)/g, '$1');
    if (isWord(t)) return t;
    throw new SyntaxError(`Unexpected "${t}"`);
  };
  function or() {
    const parts = [and()];
    while (peek() === '||') {
      i++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : { or: parts };
  }
  function and() {
    const parts = [unary()];
    while (peek() === '&&') {
      i++;
      parts.push(unary());
    }
    return parts.length === 1 ? parts[0] : { and: parts };
  }
  function unary() {
    if (peek() === '!') {
      i++;
      return { not: unary() };
    }
    if (peek() === '(') {
      i++;
      const inner = or();
      take(')');
      return inner;
    }
    const key = peek();
    if (!isWord(key)) throw new SyntaxError(key === undefined ? 'Unexpected end' : `Unexpected "${key}"`);
    i++;
    if (peek() === '==' || peek() === '!=') {
      const op = tokens[i++];
      return { key, op, value: literal(tokens[i++]) };
    }
    return { key };
  }
  if (!tokens.length) throw new SyntaxError('Empty condition');
  const tree = or();
  if (i < tokens.length) throw new SyntaxError(`Unexpected "${tokens[i]}"`);
  return tree;
}

function truthy(v) {
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function evaluate(tree, lookup) {
  if (tree.or) return tree.or.some((t) => evaluate(t, lookup));
  if (tree.and) return tree.and.every((t) => evaluate(t, lookup));
  if (tree.not) return !evaluate(tree.not, lookup);
  const v = lookup(tree.key);
  if (!tree.op) return truthy(v);
  const same = String(v === undefined || v === null ? '' : v) === tree.value;
  return tree.op === '==' ? same : !same;
}

const parsed = new Map();

// Whether `text` holds for the keys `lookup(key)` gives. No condition holds;
// a malformed one does not (manifest checks report those).
function evaluateWhen(text, lookup) {
  if (text === undefined || text === null || text === '') return true;
  let tree = parsed.get(text);
  if (tree === undefined) {
    try {
      tree = parseWhen(text);
    } catch (err) {
      tree = null;
    }
    parsed.set(text, tree);
  }
  return tree ? evaluate(tree, lookup) : false;
}

module.exports = { parseWhen, evaluateWhen };
