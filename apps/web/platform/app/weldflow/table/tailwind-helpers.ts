// Category style mappings for Tailwind
export const getCategoryStyle = (category: string) => {
  const styles: Record<string, string> = {
    "Airlines": "bg-[#d4f4dd] text-[#0a7c2e]",
    "B2C": "bg-[#d4f4dd] text-[#0a7c2e]",
    "E-commerce": "bg-[#ffe5cc] text-[#cc5200]",
    "Transport": "bg-[#ccf0ff] text-[#0066cc]",
    "Finance": "bg-[#fff4cc] text-[#997a00]",
    "Financial Services": "bg-[#fff4cc] text-[#997a00]",
    "Information Technology": "bg-[#ffccf2] text-[#cc0088]",
    "B2B": "bg-[#d9ccff] text-[#6600cc]",
    "Publishing": "bg-[#ffd4d4] text-[#cc0000]",
    "SaaS": "bg-[#ccffeb] text-[#00664d]",
    "Internet": "bg-[#fff0cc] text-[#cc8800]",
    "Marketplace": "bg-[#e6ccff] text-[#7700cc]",
    "Computer Hardware": "bg-[#ffcccc] text-[#cc0000]",
    "Consumer Discretionary": "bg-[#ccddff] text-[#0044cc]",
    "Entertainment & Recreation": "bg-[#e6ffcc] text-[#4d9900]",
    "Broadcasting": "bg-[#ffd9cc] text-[#cc3300]",
    "Automation": "bg-[#ffedcc] text-[#cc7700]",
    "Enterprise": "bg-[#ffccdd] text-[#cc0044]",
  };
  return styles[category] || "bg-gray-100 text-gray-600";
};