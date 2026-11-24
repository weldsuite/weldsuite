//! Addresses for a label: the order's shipping address (one free-text line,
//! split into street and number), the warehouse or the account's sender
//! address, and the corrections the label dialog sends.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use weldsuite_schema::tenant::warehouses;
use weldsuite_shipping_domain::Address;
use weldsuite_shipping_domain::address::split_street;

use super::field;

/// An address as the API takes it: every field optional, either `street`
/// and `houseNumber` or one `line1`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AddressInput {
    pub(crate) name: Option<String>,
    pub(crate) company: Option<String>,
    pub(crate) street: Option<String>,
    pub(crate) house_number: Option<String>,
    pub(crate) house_number_suffix: Option<String>,
    pub(crate) line1: Option<String>,
    pub(crate) line2: Option<String>,
    pub(crate) postal_code: Option<String>,
    pub(crate) city: Option<String>,
    pub(crate) state: Option<String>,
    pub(crate) country: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) phone: Option<String>,
}

fn some(value: Option<&String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

impl AddressInput {
    /// Read the camelCase fields of a stored JSON address (`orders.
    /// shipping_address`, `carriers.settings.senderAddress`).
    pub(crate) fn from_json(value: &Value) -> Self {
        Self {
            name: field(value, "name"),
            company: field(value, "company").or_else(|| field(value, "companyName")),
            street: field(value, "street"),
            house_number: field(value, "houseNumber"),
            house_number_suffix: field(value, "houseNumberSuffix"),
            line1: field(value, "line1").or_else(|| field(value, "address1")),
            line2: field(value, "line2").or_else(|| field(value, "address2")),
            postal_code: field(value, "postalCode").or_else(|| field(value, "zip")),
            city: field(value, "city"),
            state: field(value, "state"),
            country: field(value, "country").or_else(|| field(value, "countryCode")),
            email: field(value, "email"),
            phone: field(value, "phone"),
        }
    }

    /// `self`, with every field `over` sets replacing it. A new `line1`
    /// without a street replaces the street and number too.
    #[must_use]
    pub(crate) fn merged(mut self, over: &Self) -> Self {
        macro_rules! take {
            ($($f:ident),*) => {$(
                if let Some(v) = some(over.$f.as_ref()) {
                    self.$f = Some(v);
                }
            )*};
        }
        if some(over.line1.as_ref()).is_some() && some(over.street.as_ref()).is_none() {
            self.street = None;
            self.house_number = None;
            self.house_number_suffix = None;
        }
        take!(
            name,
            company,
            street,
            house_number,
            house_number_suffix,
            line1,
            line2,
            postal_code,
            city,
            state,
            country,
            email,
            phone
        );
        self
    }

    /// The carrier's address: the street and number as given, else split
    /// from `line1`.
    pub(crate) fn resolve(&self) -> Address {
        let country = some(self.country.as_ref())
            .unwrap_or_default()
            .to_ascii_uppercase();
        let (street, house_number, suffix) = if let Some(street) = some(self.street.as_ref()) {
            (
                street,
                some(self.house_number.as_ref()).unwrap_or_default(),
                some(self.house_number_suffix.as_ref()),
            )
        } else {
            let parts = split_street(self.line1.as_deref().unwrap_or(""), &country);
            (parts.street, parts.house_number, parts.suffix)
        };
        Address {
            name: some(self.name.as_ref()),
            company: some(self.company.as_ref()),
            street,
            house_number,
            house_number_suffix: suffix,
            address_line_2: some(self.line2.as_ref()),
            postal_code: some(self.postal_code.as_ref()).unwrap_or_default(),
            city: some(self.city.as_ref()).unwrap_or_default(),
            state: some(self.state.as_ref()),
            country,
            email: some(self.email.as_ref()),
            phone: some(self.phone.as_ref()),
        }
    }
}

/// The order's recipient: the shipping address, with the order's customer
/// name, email and phone where the address has none.
pub(crate) fn recipient_of(order: &Value) -> AddressInput {
    let shipping = order.get("shippingAddress").cloned().unwrap_or(Value::Null);
    let mut input = AddressInput::from_json(&shipping);
    if input.name.is_none() {
        input.name = field(order, "customerName");
    }
    if input.email.is_none() {
        input.email = field(order, "customerEmail");
    }
    if input.phone.is_none() {
        input.phone = field(order, "customerPhone");
    }
    input
}

/// A warehouse's address as the sender.
pub(crate) fn warehouse_sender(warehouse: &warehouses::Model) -> AddressInput {
    AddressInput {
        name: warehouse.contact_name.clone(),
        company: Some(warehouse.name.clone()),
        line1: warehouse.address_line_1.clone(),
        line2: warehouse.address_line_2.clone(),
        postal_code: warehouse.postal_code.clone(),
        city: warehouse.city.clone(),
        state: warehouse.state.clone(),
        country: warehouse.country.clone(),
        email: warehouse.contact_email.clone(),
        phone: warehouse.contact_phone.clone(),
        ..AddressInput::default()
    }
}

/// An [`Address`] as the parcels table stores it (`recipient_address`).
pub(crate) fn stored(address: &Address) -> Value {
    let line1 = [
        address.street.as_str(),
        address.house_number.as_str(),
        address.house_number_suffix.as_deref().unwrap_or(""),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    json!({
        "line1": line1,
        "line2": address.address_line_2,
        "street": address.street,
        "houseNumber": address.house_number,
        "houseNumberSuffix": address.house_number_suffix,
        "city": address.city,
        "state": address.state,
        "postalCode": address.postal_code,
        "country": address.country,
        "company": address.company,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_order_address_is_split_and_completed() {
        let order = json!({
            "customerName": "Anna de Vries",
            "customerEmail": "anna@example.com",
            "shippingAddress": { "line1": "Damrak 1A", "city": "Amsterdam", "postalCode": "1012 LG", "country": "nl" }
        });
        let address = recipient_of(&order).resolve();
        assert_eq!(address.street, "Damrak");
        assert_eq!(address.house_number, "1");
        assert_eq!(address.house_number_suffix.as_deref(), Some("A"));
        assert_eq!(address.country, "NL");
        assert_eq!(address.name.as_deref(), Some("Anna de Vries"));
        assert_eq!(address.email.as_deref(), Some("anna@example.com"));
    }

    #[test]
    fn corrections_win_and_a_new_line_replaces_the_street() {
        let base = AddressInput {
            street: Some("Damrak".into()),
            house_number: Some("1".into()),
            city: Some("Amsterdam".into()),
            country: Some("NL".into()),
            ..AddressInput::default()
        };
        let fixed = base.clone().merged(&AddressInput {
            house_number: Some("3".into()),
            ..AddressInput::default()
        });
        assert_eq!(fixed.resolve().house_number, "3");
        let moved = base.merged(&AddressInput {
            line1: Some("Rokin 12-2".into()),
            ..AddressInput::default()
        });
        let address = moved.resolve();
        assert_eq!(
            (address.street.as_str(), address.house_number.as_str()),
            ("Rokin", "12")
        );
        assert_eq!(address.house_number_suffix.as_deref(), Some("2"));
    }
}
