# Play Store, Data Safety Form Answers

Use these answers when filling out the Data Safety section of the Google Play Console.

## Does your app collect or share any of the required user data types?
**Yes**, the app collects data.

## Is all user data collected encrypted in transit?
**Yes**, all traffic is HTTPS/TLS to `app-api.weldsuite.org`.

## Do you provide a way for users to request that their data be deleted?
**Yes**, users can request account deletion at https://weldsuite.com/support or by signing into the web platform.

## Collected data types

### Personal info
| Type | Collected | Shared | Required | Purposes |
|---|---|---|---|---|
| Name | Yes | No | Optional | App functionality |
| Email address | Yes | No | Required | App functionality, Account management |
| User IDs | Yes | No | Required | App functionality, Account management |

### App activity
| Type | Collected | Shared | Required | Purposes |
|---|---|---|---|---|
| App interactions | Yes | No | Optional | Analytics |
| Other user-generated content | Yes | No | Required | App functionality |
  (tasks, comments, project content)

### Device or other IDs
| Type | Collected | Shared | Required | Purposes |
|---|---|---|---|---|
| Device or other IDs | Yes | No | Required | App functionality |
  (push notification token)

### App info and performance
| Type | Collected | Shared | Required | Purposes |
|---|---|---|---|---|
| Crash logs | Yes | No | Optional | Analytics |
| Diagnostics | Yes | No | Optional | Analytics |

## Security practices

- Data is encrypted in transit (TLS 1.2+)
- Users can request deletion of their data
- Following best practices for secure handling of data

## Not collected

- Location (precise or approximate)
- Financial info (this app does not process payments)
- Health and fitness info
- Messages (SMS, email, IM)
- Photos and videos
- Audio files
- Files and docs (users don't upload files in v1)
- Contacts (from device)
- Web browsing history
