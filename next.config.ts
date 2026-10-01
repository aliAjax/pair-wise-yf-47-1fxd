import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl({
  reactStrictMode: true,
  transpilePackages: ["antd", "@ant-design/icons", "@ant-design/nextjs-registry"]
});
