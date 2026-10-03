import type { SVGProps } from 'react'

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      {...props}
    />
  )
}

export function IconUsers(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M17 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 5 18.5V20" />
      <circle cx="9.5" cy="8" r="3.25" />
      <path d="M16 8.25a2.75 2.75 0 1 1 2 4.6" />
      <path d="M19.5 20v-1.25a3 3 0 0 0-1.9-2.79" />
    </Icon>
  )
}

export function IconShieldCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 3.5l6.5 2.3v5.4c0 4-2.7 7-6.5 9.3-3.8-2.3-6.5-5.3-6.5-9.3V5.8L12 3.5Z" />
      <path d="M9.25 12.25l1.9 1.9 3.6-3.9" />
    </Icon>
  )
}

export function IconClock(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  )
}

export function IconBookOpen(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 6.5c-1.6-1.2-3.8-1.7-6.5-1.5v12c2.7-.2 4.9.3 6.5 1.5 1.6-1.2 3.8-1.7 6.5-1.5v-12c-2.7-.2-4.9.3-6.5 1.5Z" />
      <path d="M12 6.5v12" />
    </Icon>
  )
}

export function IconAward(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="9" r="4.75" />
      <path d="M9 13.2 7.5 20l4.5-2.3L16.5 20 15 13.2" />
    </Icon>
  )
}

export function IconRupee(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M7 5h10" />
      <path d="M7 9h10" />
      <path d="M7 5c5 0 5 8 0 8" />
      <path d="M7 13h4l6 6" />
    </Icon>
  )
}

export function IconUserPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8" r="3.25" />
      <path d="M4 20v-1.5A3.5 3.5 0 0 1 7.5 15h4A3.5 3.5 0 0 1 15 18.5V20" />
      <path d="M18.5 8v6M15.5 11h6" />
    </Icon>
  )
}

export function IconGraduationCap(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 2.5 9 12 13.5 21.5 9 12 4.5Z" />
      <path d="M6.5 11v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4" />
    </Icon>
  )
}

export function IconTrendingUp(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 16l5-5 3.5 3.5L20 7" />
      <path d="M14.5 7H20v5.5" />
    </Icon>
  )
}

export function IconTrendingDown(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 8l5 5 3.5-3.5L20 17" />
      <path d="M14.5 17H20v-5.5" />
    </Icon>
  )
}

export function IconLock(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="10.5" width="13" height="9" rx="2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    </Icon>
  )
}

export function IconLogOut(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M10 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
      <path d="M15.5 16.5 20 12l-4.5-4.5" />
      <path d="M20 12H9" />
    </Icon>
  )
}

export function IconPhone(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="7" y="3" width="10" height="18" rx="2.2" />
      <path d="M11 18h2" />
    </Icon>
  )
}

export function IconSparkles(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 3.5l1.4 3.6 3.6 1.4-3.6 1.4L12 13.5l-1.4-3.6-3.6-1.4 3.6-1.4L12 3.5Z" />
      <path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
    </Icon>
  )
}
