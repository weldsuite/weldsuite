//! Safe arithmetic expressions (`expression.ts`): trend formulas (`A / B *
//! 100`, letters are series by index) and computed properties (`price *
//! quantity`, identifiers are event property keys).
//!
//! A small hand-written parser: numbers, identifiers, `+ - * /` (also `−`,
//! `×` and `÷`), unary minus and parentheses. The same tree is evaluated
//! ([`evaluate`]) or written as SQL ([`to_sql`]); division by zero is
//! `NULL` / `None`, never an error or infinity. Positions are UTF-16 offsets,
//! as the TypeScript reports them.

use std::collections::HashMap;
use std::hash::BuildHasher;
use std::sync::LazyLock;

use regex::Regex;

use crate::js;

/// `+ - * /`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpressionOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
}

impl ExpressionOperator {
    fn symbol(self) -> &'static str {
        match self {
            Self::Add => "+",
            Self::Subtract => "-",
            Self::Multiply => "*",
            Self::Divide => "/",
        }
    }
}

/// A parsed expression.
#[derive(Debug, Clone, PartialEq)]
pub enum ExpressionNode {
    Number(f64),
    Identifier(String),
    Negate(Box<ExpressionNode>),
    Binary {
        operator: ExpressionOperator,
        left: Box<ExpressionNode>,
        right: Box<ExpressionNode>,
    },
}

/// What identifiers are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpressionIdentifierKind {
    /// Single letters `A`–`E` (case-insensitive, returned upper case).
    Series,
    /// Event property keys (`price`, `$lcp`).
    Properties,
}

/// How to parse.
#[derive(Debug, Clone, Copy)]
pub struct ParseExpressionOptions {
    pub identifiers: ExpressionIdentifierKind,
    /// `Series` only: how many series the spec has (default 5).
    pub series_count: Option<usize>,
}

/// Why a text does not parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpressionError {
    pub message: String,
    /// 0-based UTF-16 offset of the problem.
    pub position: usize,
}

/// A parsed expression and its distinct identifiers in order of first use.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedExpression {
    pub ast: ExpressionNode,
    pub identifiers: Vec<String>,
}

pub const MAX_EXPRESSION_LENGTH: usize = 500;
pub const MAX_EXPRESSION_NODES: usize = 100;
pub const MAX_EXPRESSION_DEPTH: usize = 20;
/// Largest number literal: keeps every literal in plain decimal notation.
pub const MAX_EXPRESSION_NUMBER: f64 = 1e12;
pub const SERIES_LETTERS: [&str; 5] = ["A", "B", "C", "D", "E"];

static PROPERTY_IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\$?[A-Za-z_][A-Za-z0-9_]{0,63}$").expect("a valid pattern"));

#[derive(Debug, Clone)]
enum TokenKind {
    Number(f64),
    Ident(String),
    Op(ExpressionOperator),
    LParen,
    RParen,
    End,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    pos: usize,
}

fn failure(message: impl Into<String>, position: usize) -> ExpressionError {
    ExpressionError {
        message: message.into(),
        position,
    }
}

fn is_ident_start(c: char) -> bool {
    c == '$' || c == '_' || c.is_ascii_alphabetic()
}

fn is_ident_part(c: char) -> bool {
    is_ident_start(c) || c.is_ascii_digit()
}

fn operator_of(c: char) -> Option<ExpressionOperator> {
    match c {
        '+' => Some(ExpressionOperator::Add),
        '-' | '−' => Some(ExpressionOperator::Subtract),
        '*' | '×' => Some(ExpressionOperator::Multiply),
        '/' | '÷' => Some(ExpressionOperator::Divide),
        _ => None,
    }
}

fn tokenize(text: &str) -> Result<Vec<Token>, ExpressionError> {
    let chars: Vec<char> = text.chars().collect();
    // UTF-16 offset of each char, and of the end.
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut unit = 0;
    for c in &chars {
        offsets.push(unit);
        unit += c.len_utf16();
    }
    offsets.push(unit);

    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let pos = offsets[i];
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            i += 1;
            continue;
        }
        let digit_next = chars.get(i + 1).is_some_and(char::is_ascii_digit);
        if c.is_ascii_digit() || (c == '.' && digit_next) {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if chars.get(i) == Some(&'.') {
                i += 1;
                let fraction_start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i == fraction_start {
                    return Err(failure("A number needs digits after the point", offsets[i]));
                }
            }
            let raw: String = chars[start..i].iter().collect();
            let value = js::string_to_number(&raw);
            if !value.is_finite() || value > MAX_EXPRESSION_NUMBER {
                return Err(failure("That number is too large", pos));
            }
            if chars.get(i).is_some_and(|c| is_ident_start(*c)) {
                return Err(failure(
                    "Put an operator between a number and a name",
                    offsets[i],
                ));
            }
            tokens.push(Token {
                kind: TokenKind::Number(value),
                pos,
            });
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            i += 1;
            while i < chars.len() && is_ident_part(chars[i]) {
                i += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Ident(chars[start..i].iter().collect()),
                pos,
            });
            continue;
        }
        let kind = if let Some(op) = operator_of(c) {
            TokenKind::Op(op)
        } else if c == '(' {
            TokenKind::LParen
        } else if c == ')' {
            TokenKind::RParen
        } else {
            return Err(failure(format!("Unexpected character \"{c}\""), pos));
        };
        tokens.push(Token { kind, pos });
        i += 1;
    }
    tokens.push(Token {
        kind: TokenKind::End,
        pos: unit,
    });
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
    nodes: usize,
    options: ParseExpressionOptions,
    identifiers: Vec<String>,
}

impl Parser {
    fn parse(&mut self) -> Result<ExpressionNode, ExpressionError> {
        let node = self.expression(0)?;
        let next = self.peek().clone();
        match next.kind {
            TokenKind::End => Ok(node),
            TokenKind::RParen => Err(failure("Unmatched closing parenthesis", next.pos)),
            _ => Err(failure("Expected an operator", next.pos)),
        }
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.index.min(self.tokens.len() - 1)]
    }

    fn take(&mut self) -> Token {
        let token = self.peek().clone();
        self.index += 1;
        token
    }

    fn count(&mut self, pos: usize) -> Result<(), ExpressionError> {
        self.nodes += 1;
        if self.nodes > MAX_EXPRESSION_NODES {
            return Err(failure("The formula is too long", pos));
        }
        Ok(())
    }

    fn guard_depth(depth: usize, pos: usize) -> Result<(), ExpressionError> {
        if depth > MAX_EXPRESSION_DEPTH {
            return Err(failure("The formula nests too deeply", pos));
        }
        Ok(())
    }

    fn binary_op(&self, accept: [ExpressionOperator; 2]) -> Option<(ExpressionOperator, usize)> {
        match self.peek() {
            Token {
                kind: TokenKind::Op(op),
                pos,
            } if accept.contains(op) => Some((*op, *pos)),
            _ => None,
        }
    }

    fn expression(&mut self, depth: usize) -> Result<ExpressionNode, ExpressionError> {
        let mut left = self.term(depth)?;
        while let Some((operator, pos)) =
            self.binary_op([ExpressionOperator::Add, ExpressionOperator::Subtract])
        {
            self.take();
            self.count(pos)?;
            let right = self.term(depth)?;
            left = ExpressionNode::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn term(&mut self, depth: usize) -> Result<ExpressionNode, ExpressionError> {
        let mut left = self.unary(depth)?;
        while let Some((operator, pos)) =
            self.binary_op([ExpressionOperator::Multiply, ExpressionOperator::Divide])
        {
            self.take();
            self.count(pos)?;
            let right = self.unary(depth)?;
            left = ExpressionNode::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn unary(&mut self, depth: usize) -> Result<ExpressionNode, ExpressionError> {
        if let Some((operator, pos)) =
            self.binary_op([ExpressionOperator::Subtract, ExpressionOperator::Add])
        {
            self.take();
            Self::guard_depth(depth + 1, pos)?;
            let operand = self.unary(depth + 1)?;
            if operator == ExpressionOperator::Add {
                return Ok(operand);
            }
            self.count(pos)?;
            return Ok(ExpressionNode::Negate(Box::new(operand)));
        }
        self.primary(depth)
    }

    fn primary(&mut self, depth: usize) -> Result<ExpressionNode, ExpressionError> {
        let token = self.take();
        match token.kind {
            TokenKind::Number(value) => {
                self.count(token.pos)?;
                Ok(ExpressionNode::Number(value))
            }
            TokenKind::Ident(name) => {
                self.count(token.pos)?;
                Ok(ExpressionNode::Identifier(
                    self.identifier(&name, token.pos)?,
                ))
            }
            TokenKind::LParen => {
                Self::guard_depth(depth + 1, token.pos)?;
                let inner = self.expression(depth + 1)?;
                let close = self.take();
                if !matches!(close.kind, TokenKind::RParen) {
                    return Err(failure("Missing closing parenthesis", close.pos));
                }
                Ok(inner)
            }
            TokenKind::End => Err(failure("The formula ends too early", token.pos)),
            TokenKind::RParen => Err(failure("Unexpected closing parenthesis", token.pos)),
            TokenKind::Op(_) => Err(failure("Expected a number, a name or \"(\"", token.pos)),
        }
    }

    fn identifier(&mut self, raw: &str, pos: usize) -> Result<String, ExpressionError> {
        let name = match self.options.identifiers {
            ExpressionIdentifierKind::Series => {
                let letter = raw.to_uppercase();
                let index = SERIES_LETTERS.iter().position(|l| *l == letter);
                let count = self
                    .options
                    .series_count
                    .unwrap_or(SERIES_LETTERS.len())
                    .min(SERIES_LETTERS.len());
                let Some(index) = index.filter(|_| js::utf16_len(raw) == 1) else {
                    return Err(failure("Use the letters A to E for the series", pos));
                };
                if index >= count {
                    return Err(failure(format!("There is no series {letter}"), pos));
                }
                letter
            }
            ExpressionIdentifierKind::Properties => {
                if !PROPERTY_IDENTIFIER.is_match(raw) {
                    return Err(failure(
                        format!("\"{}\" is not a property name", js::slice_utf16(raw, 0, 70)),
                        pos,
                    ));
                }
                raw.to_owned()
            }
        };
        if !self.identifiers.contains(&name) {
            self.identifiers.push(name.clone());
        }
        Ok(name)
    }
}

/// Parses `text`. A formula that does not parse is an [`ExpressionError`]
/// with a message and the offset of the problem.
pub fn parse_expression(
    text: &str,
    options: ParseExpressionOptions,
) -> Result<ParsedExpression, ExpressionError> {
    if js::trim(text).is_empty() {
        return Err(failure("Enter a formula", 0));
    }
    if js::utf16_len(text) > MAX_EXPRESSION_LENGTH {
        return Err(failure(
            format!("Use at most {MAX_EXPRESSION_LENGTH} characters"),
            MAX_EXPRESSION_LENGTH,
        ));
    }
    let mut parser = Parser {
        tokens: tokenize(text)?,
        index: 0,
        nodes: 0,
        options,
        identifiers: Vec::new(),
    };
    let ast = parser.parse()?;
    Ok(ParsedExpression {
        ast,
        identifiers: parser.identifiers,
    })
}

/// The 0-based series index of a letter (`A` → 0).
pub fn series_index(letter: &str) -> Option<usize> {
    let upper = letter.to_uppercase();
    SERIES_LETTERS.iter().position(|l| *l == upper)
}

/// Every identifier in the tree, distinct, in order of first use.
pub fn expression_identifiers(ast: &ExpressionNode) -> Vec<String> {
    fn walk(node: &ExpressionNode, out: &mut Vec<String>) {
        match node {
            ExpressionNode::Identifier(name) => {
                if !out.contains(name) {
                    out.push(name.clone());
                }
            }
            ExpressionNode::Negate(operand) => walk(operand, out),
            ExpressionNode::Binary { left, right, .. } => {
                walk(left, out);
                walk(right, out);
            }
            ExpressionNode::Number(_) => {}
        }
    }
    let mut out = Vec::new();
    walk(ast, &mut out);
    out
}

/// The value of the tree. A missing or non-finite identifier, division by
/// zero or a non-finite result is `None`.
pub fn evaluate<S: BuildHasher>(
    ast: &ExpressionNode,
    values: &HashMap<String, Option<f64>, S>,
) -> Option<f64> {
    match ast {
        ExpressionNode::Number(value) => Some(*value),
        ExpressionNode::Identifier(name) => values
            .get(name)
            .copied()
            .flatten()
            .filter(|v| v.is_finite()),
        ExpressionNode::Negate(operand) => evaluate(operand, values).map(|v| -v),
        ExpressionNode::Binary {
            operator,
            left,
            right,
        } => {
            let left = evaluate(left, values);
            let right = evaluate(right, values);
            match (left, right) {
                (Some(left), Some(right)) => apply(*operator, left, right),
                _ => None,
            }
        }
    }
}

fn apply(operator: ExpressionOperator, left: f64, right: f64) -> Option<f64> {
    if operator == ExpressionOperator::Divide && right == 0.0 {
        return None;
    }
    let result = match operator {
        ExpressionOperator::Add => left + right,
        ExpressionOperator::Subtract => left - right,
        ExpressionOperator::Multiply => left * right,
        ExpressionOperator::Divide => left / right,
    };
    result.is_finite().then_some(result)
}

/// A number literal in plain decimal notation, always with a point so SQL
/// engines divide as floating point. `None` out of range.
fn sql_number(value: f64) -> Option<String> {
    if !value.is_finite() || value.abs() > MAX_EXPRESSION_NUMBER {
        return None;
    }
    if value.fract() == 0.0 {
        return Some(format!("{}.0", js::number_text(value)));
    }
    let text = js::number_text(value);
    if !text.contains('e') {
        return Some(text);
    }
    Some(js::to_fixed(value, 20).trim_end_matches('0').to_owned())
}

/// A number literal [`to_sql`] cannot write (larger than
/// [`MAX_EXPRESSION_NUMBER`], which [`parse_expression`] already refuses).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NumberOutOfRange;

/// The tree as a SQL expression. `resolve` turns each identifier into SQL
/// (and is where it is checked and escaped); numbers are written here.
/// Division by zero is `NULL` (`NULLIF`).
pub fn to_sql<E: From<NumberOutOfRange>>(
    ast: &ExpressionNode,
    resolve: &mut dyn FnMut(&str) -> Result<String, E>,
) -> Result<String, E> {
    Ok(match ast {
        ExpressionNode::Number(value) => sql_number(*value).ok_or(NumberOutOfRange)?,
        ExpressionNode::Identifier(name) => format!("({})", resolve(name)?),
        ExpressionNode::Negate(operand) => format!("(-{})", to_sql(operand, resolve)?),
        ExpressionNode::Binary {
            operator,
            left,
            right,
        } => {
            let left = to_sql(left, resolve)?;
            let right = to_sql(right, resolve)?;
            if *operator == ExpressionOperator::Divide {
                format!("({left} / NULLIF({right}, 0))")
            } else {
                format!("({left} {} {right})", operator.symbol())
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(text: &str, count: usize) -> Result<ParsedExpression, ExpressionError> {
        parse_expression(
            text,
            ParseExpressionOptions {
                identifiers: ExpressionIdentifierKind::Series,
                series_count: Some(count),
            },
        )
    }

    fn properties(text: &str) -> Result<ParsedExpression, ExpressionError> {
        parse_expression(
            text,
            ParseExpressionOptions {
                identifiers: ExpressionIdentifierKind::Properties,
                series_count: None,
            },
        )
    }

    fn sql(text: &str) -> String {
        let parsed = properties(text).expect("parses");
        to_sql::<NumberOutOfRange>(&parsed.ast, &mut |key| Ok(format!("p({key})"))).expect("writes")
    }

    #[test]
    fn parses_precedence_and_unary_minus() {
        let values: HashMap<String, Option<f64>> = [("A", 4.0), ("B", 2.0), ("C", 3.0)]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), Some(v)))
            .collect();
        let eval = |text: &str| evaluate(&series(text, 3).expect("parses").ast, &values);
        assert_eq!(eval("A + B * C"), Some(10.0));
        assert_eq!(eval("(A + B) * C"), Some(18.0));
        assert_eq!(eval("-A + --B"), Some(-2.0));
        assert_eq!(eval("a × b ÷ c − 1"), Some(4.0 * 2.0 / 3.0 - 1.0));
        assert_eq!(eval("A / (B - 2)"), None);
        assert_eq!(series("A + B", 3).expect("parses").identifiers, ["A", "B"]);
    }

    #[test]
    fn refuses_with_positions() {
        let err = |text: &str| series(text, 2).expect_err("refused");
        assert_eq!(err("A +").message, "The formula ends too early");
        assert_eq!(err("A + C").message, "There is no series C");
        assert_eq!(err("A + C").position, 4);
        assert_eq!(err("AB").message, "Use the letters A to E for the series");
        assert_eq!(err("(A").message, "Missing closing parenthesis");
        assert_eq!(err("A)").message, "Unmatched closing parenthesis");
        assert_eq!(err("A B").message, "Expected an operator");
        assert_eq!(
            err("2A").message,
            "Put an operator between a number and a name"
        );
        assert_eq!(err("1.").message, "A number needs digits after the point");
        assert_eq!(err("A ; B").message, "Unexpected character \";\"");
        assert_eq!(err("   ").message, "Enter a formula");
        assert_eq!(err("2000000000000").message, "That number is too large");
        let deep = format!("{}A{}", "(".repeat(21), ")".repeat(21));
        assert_eq!(err(&deep).message, "The formula nests too deeply");
        let long = vec!["A"; 60].join(" + ");
        assert_eq!(err(&long).message, "The formula is too long");
    }

    #[test]
    fn writes_sql_with_points_and_nullif() {
        assert_eq!(
            sql("price * quantity / 100"),
            "(((p(price)) * (p(quantity))) / NULLIF(100.0, 0))"
        );
        assert_eq!(sql("-a + 0.5"), "((-(p(a))) + 0.5)");
        assert_eq!(sql("x * 0.0000001"), "((p(x)) * 0.0000001)");
        assert_eq!(sql("$lcp / 1000"), "((p($lcp)) / NULLIF(1000.0, 0))");
        assert_eq!(
            properties("price + 1bad").expect_err("refused").message,
            "Put an operator between a number and a name"
        );
    }
}
