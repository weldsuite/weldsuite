"use client";

import { useEffect, useState } from "react";

interface FooterTimeDisplayBlockProps {
  timezone?: string;
  timezoneLabel?: string;
  alignment?: 'left' | 'center' | 'right';
}

const FooterTimeDisplayBlock = ({
  timezone = "Europe/London",
  timezoneLabel = "Time",
  alignment = "center",
}: FooterTimeDisplayBlockProps) => {
  const [time, setTime] = useState("");

  useEffect(() => {
    const updateTime = () => {
      const options: Intl.DateTimeFormatOptions = {
        timeZone: timezone,
        hour: "2-digit" as const,
        minute: "2-digit" as const,
        second: "2-digit" as const,
      };
      const formattedTime = new Intl.DateTimeFormat("en-GB", options).format(
        new Date(),
      );
      setTime(formattedTime);
    };

    updateTime();
    const intervalId = setInterval(updateTime, 1000);

    return () => clearInterval(intervalId);
  }, [timezone]);

  return (
    <div
      className="text-muted-foreground text-sm"
      style={{ textAlign: alignment }}
    >
      {timezoneLabel} → {time}
    </div>
  );
};

export { FooterTimeDisplayBlock };
