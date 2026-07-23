"use client";

import { useEffect, useState } from "react";

const FooterTimeBlock = () => {
  const [time, setTime] = useState("");

  useEffect(() => {
    const updateLondonTime = () => {
      const options: Intl.DateTimeFormatOptions = {
        timeZone: "Europe/London",
        hour: "2-digit" as const,
        minute: "2-digit" as const,
        second: "2-digit" as const,
      };
      const londonTime = new Intl.DateTimeFormat("en-GB", options).format(
        new Date(),
      );
      setTime(londonTime);
    };

    updateLondonTime();
    const intervalId = setInterval(updateLondonTime, 1000);

    return () => clearInterval(intervalId);
  }, []);

  return (
    <section className="w-full py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <footer>
          <div className="overflow-hidden max-h-[80px] sm:max-h-[120px] lg:max-h-[160px]">
            <img
              src="https://deifkwefumgah.cloudfront.net/shadcnblocks/block/shadcnblocks-giant-black-text.svg"
              alt="footer"
              className="w-full object-cover object-top"
            />
          </div>
          <div className="text-muted-foreground flex flex-col items-center justify-between py-12 md:flex-row">
            <div>© Shadcnblocks.com 2024</div>
            <div>Time → {time}</div>
            <div>example@shadcnblocks.com</div>
          </div>
        </footer>
      </div>
    </section>
  );
};

export { FooterTimeBlock };
