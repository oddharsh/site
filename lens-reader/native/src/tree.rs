//! A flat node store for html5ever. Integer handles avoid a reference-counted
//! allocation for every node and allow iterative traversal of hostile nesting.
use html5ever::{
    tendril::StrTendril,
    tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink},
    Attribute, LocalName, Namespace, QualName,
};
use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    rc::Rc,
};

pub(crate) enum Kind {
    Document,
    Element {
        name: QualName,
        attrs: Vec<Attribute>,
        template: Option<usize>,
        mathml: bool,
    },
    Text(String),
    Comment,
}
pub(crate) struct Node {
    pub kind: Kind,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
}
#[derive(Clone)]
pub(crate) struct Tree {
    pub nodes: Rc<RefCell<Vec<Node>>>,
    retained: Rc<Cell<usize>>,
    pub exceeded: Rc<Cell<bool>>,
    byte_limit: usize,
    pub depth_exceeded: Rc<Cell<bool>>,
    depth_limit: usize,
}
impl Tree {
    pub fn new(byte_limit: usize, depth_limit: usize) -> Self {
        Self {
            retained: Rc::new(Cell::new(2 * std::mem::size_of::<Node>())),
            exceeded: Rc::new(Cell::new(false)),
            byte_limit,
            depth_limit,
            depth_exceeded: Rc::new(Cell::new(false)),
            nodes: Rc::new(RefCell::new(vec![Node {
                kind: Kind::Document,
                parent: None,
                children: vec![],
            }])),
        }
    }
    // Charge payload before retaining it. After failure we retain only the
    // handles/names needed to finish the current parser feed safely; callers
    // observe the error immediately after that feed and publish no tree.
    fn charge(&self, bytes: usize) -> bool {
        if self.exceeded.get() {
            return false;
        }
        match self.retained.get().checked_add(bytes) {
            Some(total) if total <= self.byte_limit => {
                self.retained.set(total);
                true
            }
            _ => {
                self.exceeded.set(true);
                false
            }
        }
    }
    fn attributes_cost(attrs: &[Attribute]) -> usize {
        attrs
            .iter()
            .map(|a| 2 * (std::mem::size_of::<Attribute>() + a.name.local.len() + a.value.len()))
            .sum()
    }
    fn create(&self, kind: Kind) -> usize {
        self.charge(2 * std::mem::size_of::<Node>());
        let mut nodes = self.nodes.borrow_mut();
        let id = nodes.len();
        nodes.push(Node {
            kind,
            parent: None,
            children: vec![],
        });
        id
    }
    fn check_depth(&self, root: usize) {
        if self.depth_exceeded.get() {
            return;
        }
        let nodes = self.nodes.borrow();
        let mut depth = 0usize;
        let mut parent = nodes[root].parent;
        while let Some(id) = parent {
            depth += 1;
            if depth > self.depth_limit {
                self.depth_exceeded.set(true);
                return;
            }
            parent = nodes[id].parent;
        }
        let mut stack = vec![(root, depth)];
        while let Some((id, level)) = stack.pop() {
            if level > self.depth_limit {
                self.depth_exceeded.set(true);
                return;
            }
            stack.extend(nodes[id].children.iter().map(|&child| (child, level + 1)));
        }
    }
    fn insert(&self, parent: usize, position: usize, child: NodeOrText<usize>) {
        self.charge(2 * std::mem::size_of::<usize>());
        match child {
            NodeOrText::AppendText(text) => {
                if text.is_empty() || !self.charge(2 * text.len()) {
                    return;
                }
                let mut nodes = self.nodes.borrow_mut();
                if position > 0 {
                    let previous = nodes[parent].children[position - 1];
                    if let Kind::Text(old) = &mut nodes[previous].kind {
                        old.push_str(&text);
                        return;
                    }
                }
                self.charge(2 * std::mem::size_of::<Node>());
                let id = nodes.len();
                nodes.push(Node {
                    kind: Kind::Text(text.to_string()),
                    parent: Some(parent),
                    children: vec![],
                });
                nodes[parent].children.insert(position, id);
            }
            NodeOrText::AppendNode(id) => {
                let mut nodes = self.nodes.borrow_mut();
                let mut at = position;
                if let Some(old_parent) = nodes[id].parent {
                    if let Some(old_position) =
                        nodes[old_parent].children.iter().position(|&c| c == id)
                    {
                        nodes[old_parent].children.remove(old_position);
                        if old_parent == parent && old_position < at {
                            at -= 1;
                        }
                    }
                }
                nodes[id].parent = Some(parent);
                nodes[parent].children.insert(at, id);
                drop(nodes);
                self.check_depth(id);
            }
        }
    }
}
#[derive(Debug)]
pub(crate) struct Name(QualName);
impl html5ever::tree_builder::ElemName for Name {
    fn ns(&self) -> &Namespace {
        &self.0.ns
    }
    fn local_name(&self) -> &LocalName {
        &self.0.local
    }
}
impl TreeSink for Tree {
    type Handle = usize;
    type Output = Self;
    type ElemName<'a> = Name;
    fn finish(self) -> Self {
        self
    }
    fn parse_error(&self, _: Cow<'static, str>) {}
    fn get_document(&self) -> usize {
        0
    }
    fn elem_name<'a>(&'a self, target: &'a usize) -> Name {
        match &self.nodes.borrow()[*target].kind {
            Kind::Element { name, .. } => Name(name.clone()),
            _ => panic!("html5ever requested an element name for a non-element"),
        }
    }
    fn create_element(
        &self,
        name: QualName,
        mut attrs: Vec<Attribute>,
        flags: ElementFlags,
    ) -> usize {
        if !self.charge(Self::attributes_cost(&attrs) + 2 * name.local.len()) {
            attrs.clear();
        }
        let template = flags.template.then(|| self.create(Kind::Document));
        self.create(Kind::Element {
            name,
            attrs,
            template,
            mathml: flags.mathml_annotation_xml_integration_point,
        })
    }
    fn create_comment(&self, _: StrTendril) -> usize {
        self.create(Kind::Comment)
    }
    fn create_pi(&self, _: StrTendril, _: StrTendril) -> usize {
        self.create(Kind::Comment)
    }
    fn append(&self, parent: &usize, child: NodeOrText<usize>) {
        let end = self.nodes.borrow()[*parent].children.len();
        self.insert(*parent, end, child);
    }
    fn append_based_on_parent_node(
        &self,
        element: &usize,
        previous: &usize,
        child: NodeOrText<usize>,
    ) {
        let has_parent = self.nodes.borrow()[*element].parent.is_some();
        if has_parent {
            self.append_before_sibling(element, child);
        } else {
            self.append(previous, child);
        }
    }
    fn append_doctype_to_document(&self, _: StrTendril, _: StrTendril, _: StrTendril) {}
    fn get_template_contents(&self, target: &usize) -> usize {
        match self.nodes.borrow()[*target].kind {
            Kind::Element {
                template: Some(id), ..
            } => id,
            _ => panic!("html5ever requested template contents from another node"),
        }
    }
    fn same_node(&self, a: &usize, b: &usize) -> bool {
        a == b
    }
    fn set_quirks_mode(&self, _: QuirksMode) {}
    fn append_before_sibling(&self, sibling: &usize, child: NodeOrText<usize>) {
        let (parent, position) = {
            let nodes = self.nodes.borrow();
            let parent = nodes[*sibling].parent.expect("sibling has a parent");
            (
                parent,
                nodes[parent]
                    .children
                    .iter()
                    .position(|id| id == sibling)
                    .expect("sibling is attached"),
            )
        };
        self.insert(parent, position, child);
    }
    fn add_attrs_if_missing(&self, target: &usize, extra: Vec<Attribute>) {
        if !self.charge(Self::attributes_cost(&extra)) {
            return;
        }
        if let Kind::Element { attrs, .. } = &mut self.nodes.borrow_mut()[*target].kind {
            for attr in extra {
                if !attrs.iter().any(|old| old.name == attr.name) {
                    attrs.push(attr);
                }
            }
        }
    }
    fn remove_from_parent(&self, target: &usize) {
        let mut nodes = self.nodes.borrow_mut();
        if let Some(parent) = nodes[*target].parent.take() {
            nodes[parent].children.retain(|id| id != target);
        }
    }
    fn reparent_children(&self, node: &usize, new_parent: &usize) {
        let mut nodes = self.nodes.borrow_mut();
        let children = std::mem::take(&mut nodes[*node].children);
        for child in &children {
            nodes[*child].parent = Some(*new_parent);
        }
        nodes[*new_parent].children.extend(children);
        drop(nodes);
        self.check_depth(*new_parent);
    }
    fn is_mathml_annotation_xml_integration_point(&self, target: &usize) -> bool {
        matches!(
            self.nodes.borrow()[*target].kind,
            Kind::Element { mathml: true, .. }
        )
    }
}
