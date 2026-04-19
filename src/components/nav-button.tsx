import { useState } from "react";

interface NavButtonProps {
  name: string;
  icon?: React.ReactNode;
}

export default function NavButton({ name, icon}: NavButtonProps) {
  const [hovered, setHovered] = useState(false);
  const scrollToDiv = () => {
  document.getElementById("target")?.scrollIntoView({
    behavior: "smooth"
  });
};

  return (
    <button
      className="flex flex-row font-semibold rounded-lg justify-start gap-3 items-center text-primary-foreground text-left pl-3 w-full h-[2vw] cursor-pointer transition-colors"
      style={{ backgroundColor: hovered ? "rgba(255,255,255,0.1)" : "transparent" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        const element = document.getElementById(name.toLowerCase() + "-section");
        if (element) {
          element.scrollIntoView({ behavior: "smooth" });
        }
      }}
    >
      {icon}
      {name}
    </button>
  );
}