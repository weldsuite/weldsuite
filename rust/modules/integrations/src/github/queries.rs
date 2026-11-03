//! The GraphQL documents of `github/projects.ts`, byte for byte (copied from it).

pub(crate) const PROJECT_ITEMS_QUERY: &str = "\n  query ($id: ID!, $cursor: String) {\n    node(id: $id) {\n      ... on ProjectV2 {\n        items(first: 100, after: $cursor) {\n          nodes {\n            id\n            fieldValueByName(name: \"Status\") {\n              ... on ProjectV2ItemFieldSingleSelectValue {\n                optionId\n                name\n              }\n            }\n            content {\n              __typename\n              ... on Issue {\n                id\n                number\n                title\n                body\n                state\n                stateReason\n                updatedAt\n                url\n                labels(first: 50) { nodes { name } }\n                repository { databaseId nameWithOwner }\n              }\n            }\n          }\n          pageInfo { hasNextPage endCursor }\n        }\n      }\n    }\n  }\n";

pub(crate) const UPDATE_ITEM_STATUS_MUTATION: &str = "\n  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {\n    updateProjectV2ItemFieldValue(\n      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }\n    ) {\n      projectV2Item { id }\n    }\n  }\n";

pub(crate) const ADD_ITEM_MUTATION: &str = "\n  mutation ($projectId: ID!, $contentId: ID!) {\n    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {\n      item { id }\n    }\n  }\n";

pub(crate) const UPDATE_ISSUE_MUTATION: &str = "\n  mutation ($id: ID!, $title: String, $body: String) {\n    updateIssue(input: { id: $id, title: $title, body: $body }) {\n      issue { updatedAt }\n    }\n  }\n";

pub(crate) const CLOSE_ISSUE_MUTATION: &str = "\n  mutation ($id: ID!, $reason: IssueClosedStateReason!) {\n    closeIssue(input: { issueId: $id, stateReason: $reason }) {\n      issue { updatedAt }\n    }\n  }\n";

pub(crate) const REOPEN_ISSUE_MUTATION: &str = "\n  mutation ($id: ID!) {\n    reopenIssue(input: { issueId: $id }) {\n      issue { updatedAt }\n    }\n  }\n";
