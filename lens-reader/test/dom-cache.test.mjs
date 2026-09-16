import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML as fitted } from '../src/dom.ts';
import { parseHTML as oracle } from 'linkedom';

test('text reads stay current through edits, moves, clears, and detached-node reuse', () => {
  const html = '<html><head></head><body><main><section><b>one</b><i>two</i><!--ignored--></section><aside>three</aside></main></body></html>';
  const docs = [oracle(html).document, fitted(html).document];
  const roots = docs.map(d => d.querySelector('main'));
  const sections = roots.map(r => r.querySelector('section'));
  const asides = roots.map(r => r.querySelector('aside'));
  const texts = roots.map(r => r.querySelector('b').firstChild);
  const check = () => {
    // Warm every ancestor, including the empty-string cache, before each edit.
    for (let i = 0; i < 2; i++) {
      assert.equal(roots[1].textContent, roots[0].textContent);
      assert.equal(sections[1].textContent, sections[0].textContent);
      assert.equal(asides[1].textContent, asides[0].textContent);
      assert.equal(roots[1].outerHTML, roots[0].outerHTML);
    }
  };
  const both = (fn) => { for (let i = 0; i < 2; i++) fn(i); check(); };
  check();
  both(i => { texts[i].data = 'changed'; });
  both(i => { texts[i].nodeValue = 'node value'; });
  both(i => { texts[i].textContent = 'text value'; });
  both(i => sections[i].appendChild(docs[i].createTextNode(' appended')));
  both(i => sections[i].insertBefore(docs[i].createTextNode('inserted '), sections[i].firstChild));
  both(i => asides[i].appendChild(sections[i].querySelector('b')));
  both(i => sections[i].replaceChild(asides[i].firstChild, sections[i].querySelector('i')));
  both(i => sections[i].appendChild(asides[i].cloneNode(true)));
  both(i => { sections[i].firstChild.remove(); });
  both(i => { sections[i].innerHTML = '<strong>new</strong>'; });
  both(i => { asides[i].textContent = ''; });
  both(i => { asides[i].appendChild(texts[i]); });
  both(i => { sections[i].textContent = ''; });
  both(i => { sections[i].innerHTML = ''; });
  both(i => { asides[i].textContent = 'reset'; });
  both(i => { texts[i].data = 'detached edit'; });
  both(i => { sections[i].appendChild(texts[i]); });
});

test('replacing with an existing sibling preserves order and current text', () => {
  for (const indices of [[0, 2], [2, 0], [1, 1]]) {
    const trees = [oracle, fitted].map(parse => parse('<main><b>a</b><i>b</i><u>c</u></main>').document.documentElement);
    for (const tree of trees) {
      assert.equal(tree.textContent, 'abc');
      const nodes = [...tree.children];
      tree.replaceChild(nodes[indices[0]], nodes[indices[1]]);
    }
    assert.equal(trees[1].outerHTML, trees[0].outerHTML);
    assert.equal(trees[1].textContent, trees[0].textContent);
  }
});

test('first-match searches preserve document order, template boundaries, and root inclusion', () => {
  const html = '<main id="root"><template><span id="hidden">hidden</span></template><p id="first">one</p><p id="last">two</p></main>';
  for (const parse of [oracle, fitted]) {
    const { document } = parse(html);
    assert.equal(document.querySelector('main').id, 'root');
    assert.equal(document.documentElement.querySelector('main'), null);
    assert.equal(document.querySelector('p, main').id, 'root');
    assert.equal(document.documentElement.querySelector('p').id, 'first');
    assert.equal(document.querySelector('span'), null);
    assert.equal(document.getElementById('hidden').textContent, 'hidden');
    assert.equal(document.getElementById('root'), document.documentElement);
    assert.equal(document.querySelector('[id=missing]'), null);
  }
  assert.throws(() => fitted(html).document.querySelector('p > span'), /unsupported selector/);
});
