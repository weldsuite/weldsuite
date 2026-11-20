//! Finding blocks and fields in a definition, and grouping field types by
//! the kind of answer they hold (`blocks.ts`).

use super::definition::{Block, Choice, Field, FieldKind, FormDefinition, GroupChild};

/// Sub-fields of contact info, in display order.
pub const CONTACT_PARTS: [&str; 5] = ["firstName", "lastName", "email", "phone", "company"];
/// Sub-fields of an address, in display order.
pub const ADDRESS_PARTS: [&str; 6] = ["line1", "line2", "city", "state", "postalCode", "country"];

/// A part of a composite field with its settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Part {
    pub name: &'static str,
    pub enabled: bool,
    pub required: bool,
}

impl FieldKind {
    /// Multiple choice, dropdown, picture choice: the answer is choice ids.
    pub fn is_choice(&self) -> bool {
        matches!(
            self,
            Self::MultipleChoice(_) | Self::Dropdown(_) | Self::PictureChoice(_)
        )
    }

    /// Free text: short and long text, email, phone, website.
    pub fn is_text(&self) -> bool {
        matches!(
            self,
            Self::ShortText(_)
                | Self::LongText(_)
                | Self::Email(_)
                | Self::Phone(_)
                | Self::Website(_)
        )
    }

    /// Number, rating, opinion scale, NPS: the answer is a number.
    pub fn is_numeric(&self) -> bool {
        matches!(
            self,
            Self::Number(_) | Self::Rating(_) | Self::OpinionScale(_) | Self::Nps(_)
        )
    }

    /// Yes/no and legal: the answer is a boolean.
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::YesNo(_) | Self::Legal(_))
    }

    /// Contact info and address: named sub-fields.
    pub fn is_composite(&self) -> bool {
        matches!(self, Self::ContactInfo(_) | Self::Address(_))
    }

    /// File upload and signature: files uploaded through a session.
    pub fn is_file(&self) -> bool {
        matches!(self, Self::FileUpload(_) | Self::Signature(_))
    }
}

impl Field {
    /// The choices of a choice or ranking field; empty for any other type.
    pub fn choices(&self) -> &[Choice] {
        match &self.kind {
            FieldKind::MultipleChoice(props) => &props.choices,
            FieldKind::Dropdown(props) => &props.choices,
            FieldKind::PictureChoice(props) => &props.choices,
            FieldKind::Ranking(props) => &props.choices,
            _ => &[],
        }
    }

    /// Whether the field can add to `score` or appear in quiz results: a
    /// choice field with a scored or correct choice.
    pub fn is_scored(&self) -> bool {
        self.kind.is_choice()
            && self
                .choices()
                .iter()
                .any(|choice| choice.score.is_some() || choice.correct.is_some())
    }

    /// The parts of a composite field in display order, with their settings;
    /// empty for any other type.
    pub fn parts(&self) -> Vec<Part> {
        let part = |name, sub: super::definition::SubField| Part {
            name,
            enabled: sub.enabled,
            required: sub.required,
        };
        match &self.kind {
            FieldKind::ContactInfo(props) => {
                let f = props.fields;
                vec![
                    part("firstName", f.first_name),
                    part("lastName", f.last_name),
                    part("email", f.email),
                    part("phone", f.phone),
                    part("company", f.company),
                ]
            }
            FieldKind::Address(props) => {
                let f = props.fields;
                vec![
                    part("line1", f.line1),
                    part("line2", f.line2),
                    part("city", f.city),
                    part("state", f.state),
                    part("postalCode", f.postal_code),
                    part("country", f.country),
                ]
            }
            _ => Vec::new(),
        }
    }
}

/// A block found by id: a top-level block or a group's child.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BlockRef<'a> {
    Block(&'a Block),
    Child(&'a GroupChild),
}

impl<'a> BlockRef<'a> {
    pub fn id(&self) -> &'a str {
        match self {
            Self::Block(block) => block.id(),
            Self::Child(child) => child.id(),
        }
    }

    pub fn as_field(&self) -> Option<&'a Field> {
        match self {
            Self::Block(block) => block.as_field(),
            Self::Child(child) => child.as_field(),
        }
    }
}

/// The fields inside one top-level block: the block itself, or a group's
/// field children.
pub fn block_fields(block: &Block) -> Vec<&Field> {
    match block {
        Block::Field(field) => vec![field],
        Block::Group(group) => group
            .children
            .iter()
            .filter_map(GroupChild::as_field)
            .collect(),
        Block::Statement(_) | Block::PageBreak(_) => Vec::new(),
    }
}

/// Every field in order, group children included.
pub fn fields_of(def: &FormDefinition) -> Vec<&Field> {
    def.blocks.iter().flat_map(block_fields).collect()
}

/// A top-level block or a group child by id.
pub fn find_block<'a>(def: &'a FormDefinition, id: &str) -> Option<BlockRef<'a>> {
    for block in &def.blocks {
        if block.id() == id {
            return Some(BlockRef::Block(block));
        }
        if let Block::Group(group) = block
            && let Some(child) = group.children.iter().find(|child| child.id() == id)
        {
            return Some(BlockRef::Child(child));
        }
    }
    None
}

/// A field (top-level or group child) by id.
pub fn find_field<'a>(def: &'a FormDefinition, id: &str) -> Option<&'a Field> {
    find_block(def, id).and_then(|found| found.as_field())
}

/// A field (top-level or group child) by ref.
pub fn find_field_by_ref<'a>(def: &'a FormDefinition, r#ref: &str) -> Option<&'a Field> {
    fields_of(def)
        .into_iter()
        .find(|field| field.r#ref == r#ref)
}

/// Whether a top-level block is, or (a group) contains, the given id.
fn holds(block: &Block, id: &str) -> bool {
    block.id() == id
        || matches!(block, Block::Group(group) if group.children.iter().any(|child| child.id() == id))
}

/// Index in `blocks` of the top-level block that is, or contains, the given id.
pub fn top_level_index_of(def: &FormDefinition, id: &str) -> Option<usize> {
    def.blocks.iter().position(|block| holds(block, id))
}

/// The top-level block that is, or contains, the given id.
pub fn top_level_block_of<'a>(def: &'a FormDefinition, id: &str) -> Option<&'a Block> {
    top_level_index_of(def, id).map(|index| &def.blocks[index])
}

/// Every ref in use: blocks, group children and endings.
pub fn refs_of(def: &FormDefinition) -> Vec<&str> {
    let mut refs = Vec::new();
    for block in &def.blocks {
        refs.push(block.r#ref());
        if let Block::Group(group) = block {
            refs.extend(group.children.iter().map(GroupChild::r#ref));
        }
    }
    refs.extend(def.endings.iter().map(|ending| ending.r#ref.as_str()));
    refs
}
