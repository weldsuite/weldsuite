"use client";

import { motion } from "framer-motion";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import React from "react";

import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";

const NAVIGATION = [
  { label: "Home", href: "#" },
  { label: "Collection", href: "#" },
  { label: "Projects", href: "#" },
  { label: "Pricing", href: "#" },
  { label: "Login", href: "#" },
];

const SOCIAL_LINKS = [
  { label: "Linkedin", href: "#" },
  { label: "Twitter", href: "#" },
  { label: "Facebook", href: "#" },
];

const FOOTER_LINKS = [
  { label: "Privacy Policy", href: "#" },
  { label: "Terms & Conditions", href: "#" },
];

const FooterAnimatedBlock = () => {
  return (
    <section className="w-full bg-background text-foreground dark py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="gap-15 flex flex-col justify-between lg:flex-row">
          <div className="flex flex-col gap-10">
            <p className="relative text-4xl font-medium tracking-tight lg:text-5xl">
              Unlock 800+ blocks now
            </p>
            <div className="space-y-1 text-sm font-light tracking-tight lg:text-base">
              <p>Get Support : </p>
              <a href="#">hi@shadcnblocks.com</a>
            </div>
          </div>
          <div className="grid w-full max-w-xs grid-cols-2 gap-10 text-sm font-light lg:text-base">
            <ul className="space-y-1">
              {NAVIGATION.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    className="hover:text-foreground/30 text-foreground tracking-tight"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
            <ul className="space-y-1">
              {SOCIAL_LINKS.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    className="hover:text-foreground/30 text-foreground group flex items-center gap-1 tracking-tight"
                  >
                    {item.label}{" "}
                    <ArrowUpRight className="group-hover:text-muted-foreground/50 text-foreground size-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="gap-15 mt-20 flex flex-col justify-between lg:flex-row">
          <div className="flex w-full max-w-md flex-col gap-10">
            <div className="space-y-1 text-sm font-light tracking-tight lg:text-base">
              <p>Sign up for newsletter : </p>
              <form className="border-b-foreground/10 flex w-full items-end border-b">
                <Input
                  type="text"
                  placeholder="Name*"
                  className="placeholder:text-foreground/20 mt-10 rounded-none border-0 !bg-transparent p-0 uppercase shadow-none focus-visible:ring-0 lg:text-base"
                />
                <Button type="submit" variant="ghost">
                  <ArrowRight />
                </Button>
              </form>
            </div>
          </div>
          <div className="grid w-full max-w-xs grid-cols-2 gap-10 text-sm font-light lg:text-base">
            <div className="w-32">Punjab, 141421 India, Asia</div>
            <ul className="space-y-1">
              {FOOTER_LINKS.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    className="hover:text-foreground/30 text-foreground group flex items-center gap-1 tracking-tight"
                  >
                    {item.label}{" "}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-20 w-full lg:mt-32">
          <LogoSvg />
        </div>
      </div>
    </section>
  );
};

export { FooterAnimatedBlock };

const LogoSvg = () => {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.05,
        delayChildren: 0.1,
      },
    },
  };

  const pathVariants = {
    hidden: {
      y: "100%",
      opacity: 0,
    },
    visible: {
      y: "0%",
      opacity: 1,
      transition: {
        duration: 0.5,
        ease: [0.25, 0.46, 0.45, 0.94] as const,
      },
    },
  };

  return (
    <motion.svg
      variants={containerVariants}
      initial="hidden"
      whileInView="visible"
      width="1339"
      height="370"
      viewBox="0 0 1339 370"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-full w-full"
    >
      <motion.path
        variants={pathVariants}
        d="M1333.13 163.608L1274.65 169.988C1272.99 164.08 1270.1 158.527 1265.96 153.329C1261.94 148.13 1256.51 143.936 1249.66 140.745C1242.8 137.555 1234.42 135.96 1224.49 135.96C1211.14 135.96 1199.92 138.855 1190.82 144.644C1181.84 150.434 1177.41 157.937 1177.53 167.152C1177.41 175.068 1180.3 181.508 1186.21 186.47C1192.24 191.432 1202.16 195.509 1215.98 198.699L1262.42 208.624C1288.17 214.177 1307.32 222.979 1319.84 235.03C1332.48 247.082 1338.86 262.855 1338.98 282.35C1338.86 299.482 1333.84 314.606 1323.92 327.72C1314.11 340.717 1300.46 350.878 1282.98 358.204C1265.49 365.529 1245.4 369.192 1222.72 369.192C1189.4 369.192 1162.58 362.221 1142.26 348.279C1121.94 334.219 1109.82 314.665 1105.93 289.617L1168.49 283.591C1171.32 295.879 1177.35 305.153 1186.56 311.415C1195.78 317.678 1207.77 320.809 1222.54 320.809C1237.78 320.809 1250.01 317.678 1259.23 311.415C1268.56 305.153 1273.23 297.415 1273.23 288.199C1273.23 280.401 1270.22 273.961 1264.19 268.881C1258.28 263.8 1249.07 259.901 1236.54 257.184L1190.11 247.436C1164 242.001 1144.68 232.845 1132.16 219.966C1119.63 206.969 1113.43 190.546 1113.55 170.697C1113.43 153.919 1117.98 139.387 1127.19 127.099C1136.53 114.693 1149.46 105.123 1166.01 98.3881C1182.67 91.5353 1201.86 88.1089 1223.6 88.1089C1255.51 88.1089 1280.61 94.9026 1298.93 108.49C1317.36 122.077 1328.76 140.45 1333.13 163.608Z"
        fill="currentColor"
      />
      <motion.path
        variants={pathVariants}
        d="M932.249 278.451L932.072 201.003H942.351L1040.18 91.6535H1115.15L994.81 225.637H981.518L932.249 278.451ZM873.764 363.875V0.913086H937.92V363.875H873.764ZM1044.61 363.875L955.997 239.993L999.241 194.8L1121.35 363.875H1044.61Z"
        fill="currentColor"
      />
      <motion.path
        variants={pathVariants}
        d="M744.393 369.192C717.218 369.192 693.883 363.225 674.388 351.292C655.011 339.358 640.065 322.876 629.549 301.845C619.152 280.696 613.953 256.357 613.953 228.827C613.953 201.18 619.27 176.782 629.904 155.633C640.537 134.365 655.543 117.824 674.919 106.009C694.414 94.0755 717.454 88.1089 744.038 88.1089C766.132 88.1089 785.687 92.1851 802.7 100.338C819.832 108.372 833.479 119.774 843.64 134.542C853.801 149.193 859.59 166.325 861.008 185.938H799.688C797.206 172.824 791.299 161.895 781.965 153.151C772.749 144.29 760.402 139.859 744.924 139.859C731.809 139.859 720.29 143.404 710.365 150.493C700.44 157.464 692.701 167.507 687.148 180.622C681.713 193.736 678.996 209.451 678.996 227.764C678.996 246.314 681.713 262.264 687.148 275.616C692.583 288.849 700.204 299.069 710.01 306.276C719.935 313.365 731.573 316.91 744.924 316.91C754.376 316.91 762.824 315.137 770.268 311.593C777.829 307.93 784.151 302.672 789.231 295.819C794.312 288.967 797.797 280.637 799.688 270.83H861.008C859.472 290.089 853.801 307.162 843.994 322.049C834.188 336.818 820.837 348.397 803.941 356.786C787.045 365.056 767.196 369.192 744.393 369.192Z"
        fill="currentColor"
      />
      <motion.path
        variants={pathVariants}
        d="M480.684 369.192C454.099 369.192 431.06 363.343 411.565 351.646C392.07 339.949 376.946 323.585 366.195 302.554C355.561 281.523 350.244 256.948 350.244 228.827C350.244 200.707 355.561 176.073 366.195 154.924C376.946 133.774 392.07 117.351 411.565 105.654C431.06 93.9574 454.099 88.1089 480.684 88.1089C507.268 88.1089 530.307 93.9574 549.802 105.654C569.297 117.351 584.362 133.774 594.995 154.924C605.747 176.073 611.123 200.707 611.123 228.827C611.123 256.948 605.747 281.523 594.995 302.554C584.362 323.585 569.297 339.949 549.802 351.646C530.307 363.343 507.268 369.192 480.684 369.192ZM481.038 317.796C495.452 317.796 507.504 313.838 517.192 305.921C526.881 297.887 534.088 287.135 538.814 273.666C543.658 260.197 546.08 245.191 546.08 228.65C546.08 211.991 543.658 196.927 538.814 183.457C534.088 169.87 526.881 159.059 517.192 151.025C507.504 142.99 495.452 138.973 481.038 138.973C466.269 138.973 453.981 142.99 444.175 151.025C434.486 159.059 427.22 169.87 422.376 183.457C417.65 196.927 415.287 211.991 415.287 228.65C415.287 245.191 417.65 260.197 422.376 273.666C427.22 287.135 434.486 297.887 444.175 305.921C453.981 313.838 466.269 317.796 481.038 317.796Z"
        fill="currentColor"
      />
      <motion.path
        variants={pathVariants}
        d="M335.895 0.913086V363.875H271.738V0.913086H335.895Z"
        fill="currentColor"
      />
      <motion.path
        variants={pathVariants}
        d="M0.142578 363.875V0.913086H64.2989V136.669H66.9573C70.2656 130.053 74.9326 123.023 80.9583 115.579C86.984 108.018 95.1365 101.578 105.416 96.2615C115.695 90.8265 128.81 88.109 144.76 88.109C165.791 88.109 184.755 93.4849 201.65 104.237C218.664 114.87 232.133 130.644 242.058 151.556C252.101 172.351 257.122 197.872 257.122 228.119C257.122 258.011 252.219 283.414 242.413 304.326C232.606 325.239 219.255 341.19 202.359 352.178C185.463 363.166 166.323 368.66 144.937 368.66C129.341 368.66 116.404 366.061 106.125 360.862C95.8454 355.663 87.5748 349.401 81.3128 342.076C75.1689 334.632 70.3837 327.602 66.9573 320.986H63.2356V363.875H0.142578ZM63.0583 227.764C63.0583 245.369 65.5395 260.788 70.5019 274.021C75.5824 287.254 82.8487 297.592 92.3009 305.035C101.871 312.361 113.45 316.023 127.037 316.023C141.216 316.023 153.09 312.243 162.66 304.681C172.23 297.001 179.438 286.545 184.282 273.312C189.244 259.961 191.725 244.778 191.725 227.764C191.725 210.869 189.303 195.863 184.459 182.748C179.615 169.634 172.408 159.354 162.837 151.911C153.267 144.467 141.334 140.746 127.037 140.746C113.332 140.746 101.694 144.349 92.1236 151.556C82.5533 158.764 75.287 168.866 70.3247 181.862C65.4804 194.859 63.0583 210.16 63.0583 227.764Z"
        fill="currentColor"
      />
    </motion.svg>
  );
};
