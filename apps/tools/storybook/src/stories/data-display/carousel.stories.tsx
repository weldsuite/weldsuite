import type { Meta, StoryObj } from "@storybook/react";

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@weldsuite/ui/components/carousel";
import { Card, CardContent } from "@weldsuite/ui/components/card";

const meta = {
  title: "Data Display/Carousel",
  component: Carousel,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Carousel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Carousel className="w-full max-w-xs">
      <CarouselContent>
        {Array.from({ length: 5 }, (_, i) => (
          <CarouselItem key={i}>
            <div className="p-1">
              <Card>
                <CardContent className="flex aspect-square items-center justify-center p-6">
                  <span className="text-4xl font-semibold">{i + 1}</span>
                </CardContent>
              </Card>
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};

export const ThreePerView: Story = {
  render: () => (
    <Carousel className="w-full max-w-sm" opts={{ align: "start" }}>
      <CarouselContent className="-ml-1">
        {Array.from({ length: 8 }, (_, i) => (
          <CarouselItem key={i} className="pl-1 basis-1/3">
            <div className="p-1">
              <Card>
                <CardContent className="flex aspect-square items-center justify-center p-6">
                  <span className="text-2xl font-semibold">{i + 1}</span>
                </CardContent>
              </Card>
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};
