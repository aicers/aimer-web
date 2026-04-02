# Navigation

The Aimer Web dashboard uses a sidebar for navigation, a
customer/environment selector for context switching, and
breadcrumbs for orientation.

## Sidebar

The sidebar is displayed on the left side of every dashboard page.
It contains the logo, customer selector, navigation links, and
user controls.

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

Click the collapse toggle at the bottom of the sidebar to switch
between expanded (256 px) and collapsed (64 px) views. In
collapsed mode, only icons are shown; hover over an icon to see a
tooltip with the label. The collapse state is saved in the browser
and persists across sessions.

![Sidebar collapsed](../assets/sidebar-collapsed.png)

## Customer and environment selector

Below the logo, two dropdowns let you choose the active customer
workspace and AICE environment.

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

At the bottom of the sidebar, the user section shows your display
name and email address. It also provides:

- **Theme toggle** — switch between light and dark modes.
- **Language switcher** — switch between English and Korean.
- **Sign Out** — end your session
    (see [Authentication](authentication.md)).

## Mobile menu

On screens narrower than 768 px, the sidebar is hidden and
replaced by a hamburger menu button in the top-left corner of the
header. Tapping the button opens the sidebar as a slide-over panel.
Navigating to a page automatically closes the panel.

![Mobile menu](../assets/mobile-menu.png)

## Breadcrumbs

A breadcrumb bar appears at the top of the main content area,
showing the current page path. Click any breadcrumb segment to
navigate to that level.
