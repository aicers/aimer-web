# Account Preferences

The **Account Settings** page lets you set your personal language and
timezone preferences. Open it from **Account Settings** in the sidebar.

These preferences are saved to your account, so they follow you across
devices and browsers. The header
[language switcher](navigation.md#user-section) also saves your language
to your account while you are signed in (it only affects the current
browser when signed out); this page adds a **Timezone** control, which
the switcher does not provide.

<!-- Screenshot placeholder (#402): account settings page. -->
> **Screenshot pending.** A real capture requires seeded account-preference
> data, which is not yet available. The image will be added under #402.

## Language

The **Language** control sets the language used across the app
(English or Korean). Saving the preference writes it to your account
and updates the current page; it then applies to every future
navigation and on any device where you sign in.

### How the app decides which language to show

The active language is resolved in this order:

1. **An explicit language in the URL.** A page address that already
   carries a language prefix (for example `/en/...` or `/ko/...`)
   always wins for that page — the saved preference does not override an
   explicit link.
2. **Your saved account preference.** When the address has no language
   prefix, your saved **Language** is used.
3. **Your browser's language.** With no saved preference, the app picks
   the best match among the supported languages (English, Korean) from
   your browser settings.
4. **The system default.** If nothing matches, the deployment default
   language is used.

When you sign in, your saved language is applied to this browser. If you
had switched language in this browser before ever saving a preference,
that earlier choice is adopted as your saved preference at sign-in, so it
no longer silently overrides your browser language afterwards.

## Timezone

The **Timezone** control records your preferred timezone on your
account. Choose **Automatic** to store no specific zone, or pick a
specific IANA timezone (for example `Asia/Seoul`). Only valid IANA
timezones are accepted.

This release only *stores* the preference; it does not yet change how
timestamps are displayed. Visible timestamps continue to use the
browser/default timezone until a later release wires the saved zone
into date/time formatting. The setting never changes report bucketing
boundaries, which are defined per customer and are independent of your
personal preference.

## Saving

Click **Save** to store your changes. Invalid values (an unsupported
language or an unknown timezone) are rejected and not saved.
