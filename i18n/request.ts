import { getRequestConfig } from "next-intl/server";

export default getRequestConfig(async () => ({
  locale: "zh",
  messages: (await import("../messages/zh.json")).default
}));
