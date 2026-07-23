"use client";

import { useState } from "react";
import { useRouter } from "@/hooks/use-page-transition";
import { RadioGroup, RadioGroupItem } from "@weldsuite/ui/components/radio-group";
import { Label } from "@weldsuite/ui/components/label";
import { ChevronLeft } from "lucide-react";

export default function HomePage() {
  const [selectedReason, setSelectedReason] = useState("");
  const router = useRouter();

  const returnReasons = [
    "I received the wrong item",
    "I received the wrong item",
    "I received the wrong item", 
    "I received the wrong item",
    "I received the wrong item"
  ];

  return (
    <>
      {/* Progress Bar - Only in right column */}
      <div className="h-1.5 bg-gray-200">
        <div className="h-full bg-black" style={{ width: '33%' }}></div>
      </div>
      
      <div className="flex flex-col px-8 pt-8 pb-26" style={{ minHeight: '650px' }}>
        <h2 className="text-xl font-medium mb-6 text-gray-900" style={{ fontFamily: 'Inter, sans-serif' }}>
          Why are you returning this item?
        </h2>

        <RadioGroup value={selectedReason} onValueChange={(value) => {
          setSelectedReason(value);
          setTimeout(() => {
            router.push('/proceed');
          }, 100);
        }}>
          <div className="space-y-3">
            {returnReasons.map((reason, index) => (
              <label
                key={index}
                className={`flex items-center p-[15px] rounded-lg transition-colors cursor-pointer border ${
                  selectedReason === reason + index
                    ? "bg-gray-50 border-gray-300"
                    : "bg-white border-gray-200 hover:bg-gray-50"
                }`}
              >
                <RadioGroupItem
                  value={reason + index}
                  id={`reason-${index}`}
                  className="sr-only"
                />
                <Label
                  htmlFor={`reason-${index}`}
                  className="text-[15px] font-normal cursor-pointer flex-1"
                  style={{ fontFamily: 'Inter, sans-serif' }}
                >
                  {reason}
                </Label>
              </label>
            ))}
          </div>
        </RadioGroup>
        
        {/* Spacer to fill remaining height */}
        <div className="flex-1"></div>
      </div>
      
      {/* Back Button - positioned at bottom */}
      <div className="absolute bottom-8 left-8">
        <button 
          className="flex items-center text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 px-3 py-2 -ml-3 rounded-lg transition-all" 
          onClick={() => router.back()}
          style={{ fontFamily: 'Inter, sans-serif' }}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          Back
        </button>
      </div>
    </>
  );
}