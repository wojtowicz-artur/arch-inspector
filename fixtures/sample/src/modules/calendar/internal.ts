import { reserve } from "../booking/application/reserve";

export type CalendarSlot = { id: string };
export const calendarName = reserve ? "calendar" : "calendar";
