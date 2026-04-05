# Navigation

The Aimer Web dashboard uses a top header bar for branding and
user controls, a sidebar for navigation and context switching, and
breadcrumbs for orientation.

## Header bar

A full-width header bar sits at the top of every authenticated
page. It contains:

- **Left side** — hamburger button (sidebar toggle), AIMER logo,
    and context label (e.g., "Admin" when in the admin dashboard).
- **Right side** — theme toggle, language switcher, and a user
    profile dropdown (avatar, display name, email, and chevron)
    that opens a menu with **Sign Out**.

![Header bar](../assets/header-bar.png)

## Sidebar

The sidebar is displayed on the left side of every dashboard page.
It contains the customer/environment selector and navigation links.

![Sidebar expanded](../assets/sidebar-expanded.png)

### Navigation items

The sidebar includes the following links:

- **Home** — the main landing page.
- **Events** — the event list and approval workflow.
- **Analysis** — analysis tools.
- **Reports** — report generation.
- **Dashboard** — operational overview.

Users with the Manager role see two additional items under
settings:

- **Members** — manage workspace members and invitations
    (see [Members](members.md)).
- **Customer Settings** — customer workspace configuration
    (coming soon).

### Collapsed mode

Click the hamburger button in the header bar to switch between
expanded (256 px) and collapsed (64 px) views. In collapsed mode,
icons are shown with small text labels beneath them; hover over an
item to see a tooltip with the full label. The collapse state is
saved in the browser and persists across sessions.

![Sidebar collapsed](../assets/sidebar-collapsed.png)

## Customer and environment selector

At the top of the sidebar, two dropdowns let you choose the active
customer workspace and AICE environment.

![Customer and environment selector](../assets/customer-selector.png)

- **Customer** — lists all customer workspaces you have access to.
    Switching the customer reloads workspace-specific data such as
    members, events, and configurations.
- **Environment** — lists AICE environments associated with the
    selected customer. If no environments are available, this
    dropdown is disabled.

### Bridge sessions

When you access Aimer Web through a bridge session, the customer
and environment selectors are locked and cannot be changed. A lock
icon and a "Locked to bridge session" label indicate the
locked state.

## User section

The user section is located on the right side of the header bar.
Clicking the profile dropdown opens a menu with your name and
email. From this menu you can:

- **Sign Out** — end your session
    (see [Authentication](authentication.md)).

The header bar also provides:

- **Theme toggle** — switch between light and dark modes.
- **Language switcher** — switch between English and Korean.

## Mobile menu

On screens narrower than 768 px, the sidebar is hidden and a
hamburger menu button appears in the header bar. Tapping the
button opens the sidebar as a slide-over panel. Navigating to a
page automatically closes the panel.

![Mobile menu](../assets/mobile-menu.png)

## Breadcrumbs

A breadcrumb bar appears at the top of the main content area,
showing the current page path. Click any breadcrumb segment to
navigate to that level.
