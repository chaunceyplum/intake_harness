# Test Data

Scratch fixtures for manual testing. Not used by any automated test.

## Sample intake requests

| ID | Requester | Brand | Asset type | Due | Status |
|----|-----------|-------|------------|-----|--------|
| REQ-1001 | A. Rivera | Xfinity Internet | Email | 2026-10-02 | New |
| REQ-1002 | J. Okafor | Xfinity Mobile | Social static | 2026-10-09 | In review |
| REQ-1003 | M. Lindqvist | Comcast Business | Landing page | 2026-10-16 | Blocked |

## Sample brief

> We need a promo email for the fall Internet offer. Audience is existing
> single-play video customers. Legal copy is pending. Target send is the
> first week of October.

**Expected extraction**

- brand: Xfinity Internet
- asset type: Email
- audience: existing single-play video customers
- due date: 2026-10-02
- open question: legal copy not yet supplied
