import type { CalendarSlot } from "../../calendar/internal";
import { calendarName } from "../../calendar/internal";

export function reserve(slot: CalendarSlot): string {
  return `${calendarName}:${slot.id}`;
}
