# Security Specification - TeleMarketerPro Bot

## Data Invariants
1. A Template must belong to a valid Telegram User ID.
2. An Account must have a valid phone number as its ID and a userId field matching the owner.
3. Global config (admins, bans) can only be modified by the system (server-side via Admin SDK).

## The Dirty Dozen Payloads (Red Team Tests)
1. **Identity Spoofing:** User A trying to update User B's stats.
2. **Account Hijack:** User A trying to read User B's Telegram session.
3. **Admin Escalation:** Client trying to update `/config/global` to add themselves to `admins` array.
4. **Invalid ID:** Injecting a 1MB string as a template ID.
5. **Schema Gap:** Adding `isVerified: true` to a template to bypass logic.
6. **Banned Access:** A banned user trying to fetch their templates.
7. **Phantom Template:** Creating a template with a `userId` that doesn't match the authenticated UID.
8. **Session Theft:** Trying to list ALL accounts in the `/accounts` collection.
9. **Tampering:** Updating the `addedAt` field on an account after creation.
10. **Resource Exhaustion:** Creating 10,000 templates (handled by quota, but rules should restrict size).
11. **Email Spoofing:** Not applicable here as we use Telegram ID (custom claims).
12. **Unverified Writes:** Writing to Firestore without being signed in.

## Security Architecture
- We use **Server-Side Firebase Admin SDK** for the bot logic.
- We use **Client-Side Firebase JS SDK** for the dashboard (if any).
- Rules will strictly enforce:
  - `owner` can read/write their own data.
  - `banned` users have no access.
  - `admin` context is handled via the `/config/global` relay.
