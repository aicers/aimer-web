import type messages from "./i18n/messages/ko.json";

type Messages = typeof messages;

declare module "next-intl" {
  interface AppConfig {
    Messages: Messages;
  }
}
