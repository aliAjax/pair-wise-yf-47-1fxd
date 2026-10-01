import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { Providers } from "./providers";
import "./styles.css";

export const metadata: Metadata = { title: "城市轨道交通应急协同", description: "停运事件、车站状态和公交接驳协同工作台" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const messages = await getMessages();
  return <html lang={locale}><body><AntdRegistry><NextIntlClientProvider messages={messages}><Providers>{children}</Providers></NextIntlClientProvider></AntdRegistry></body></html>;
}
