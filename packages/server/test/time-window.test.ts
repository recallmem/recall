import { describe, expect, it } from "vitest";
import { describeWindow, questionDate, timeWindow } from "../src/recall/time-window.js";

/** The window read from a question asked on Tuesday 2025-06-03, as `first to last` day. */
const on = (q: string, date = "2025-06-03") => {
  const w = timeWindow(`The current date is ${date}.\n${q}`);
  return w ? describeWindow(w) : null;
};

describe("question date", () => {
  it("reads the date a question says it is asked on", () => {
    expect(questionDate("The current date is 2025-06-03.\nWhat did I do?")).toEqual(
      new Date("2025-06-03T00:00:00Z"),
    );
    expect(questionDate("The current date is 2023/05/30 (Tue) 23:40.\nQ")).toEqual(
      new Date("2023-05-30T00:00:00Z"),
    );
    expect(questionDate("Today is 2024-02-29. Q")).toEqual(new Date("2024-02-29T00:00:00Z"));
    expect(questionDate("What did I do on 2025-05-27?")).toBeNull();
    expect(questionDate("The current date is 2025-02-30.")).toBeNull();
  });

  it("never reads the stated date itself as the time asked about", () => {
    expect(on("Where do I live?")).toBeNull();
    expect(on("How many days ago did I buy the bike?")).toBeNull();
    expect(on("Which did I do first, the trip or the course?")).toBeNull();
  });
});

describe("time windows", () => {
  it("reads explicit dates", () => {
    expect(on("What did I do on 2025-05-27?")).toBe("2025-05-27");
    expect(on("What happened on 27 May 2025?")).toBe("2025-05-27");
    expect(on("What did I eat on May 27th?")).toBe("2025-05-27");
    expect(on("Plans for the 12th of June?")).toBe("2025-06-12");
    expect(on("What did I buy in May 2024?")).toBe("2024-05-01 to 2024-05-31");
    expect(on("Anything in 2024-11?")).toBe("2024-11-01 to 2024-11-30");
    expect(on("What did I read in 2023?")).toBe("2023-01-01 to 2023-12-31");
  });

  it("puts a month or day named without a year in the latest such month, unless that is far ahead", () => {
    expect(on("What did I do in May?")).toBe("2025-05-01 to 2025-05-31");
    expect(on("What did I do in July?")).toBe("2025-07-01 to 2025-07-31");
    expect(on("What did I do in November?")).toBe("2024-11-01 to 2024-11-30");
    expect(on("What did I do in December?", "2026-01-10")).toBe("2025-12-01 to 2025-12-31");
  });

  it("reads days and weeks relative to the question's date", () => {
    expect(on("What did I cook yesterday?")).toBe("2025-06-02");
    expect(on("Who did I meet the day before yesterday?")).toBe("2025-06-01");
    expect(on("What's on today?")).toBe("2025-06-03");
    // Tuesday 2025-06-03: last Saturday is 2025-05-31, give or take a day.
    expect(on("Where did I go last Saturday?")).toBe("2025-05-30 to 2025-06-01");
    expect(on("Who did I see last weekend?")).toBe("2025-05-31 to 2025-06-01");
    // Last week: from the Monday before this week's up to today.
    expect(on("What did I do last week?")).toBe("2025-05-26 to 2025-06-03");
    expect(on("What did I do this week?")).toBe("2025-06-02 to 2025-06-03");
    expect(on("What did I watch 3 days ago?")).toBe("2025-05-30 to 2025-06-01");
    expect(on("What happened two weeks ago?")).toBe("2025-05-16 to 2025-05-28");
    expect(on("What did I buy a few days ago?")).toBe("2025-05-28 to 2025-06-03");
  });

  it("reads months, years and seasons", () => {
    expect(on("What did I do last month?")).toBe("2025-05-01 to 2025-06-03");
    expect(on("What books did I finish this year?")).toBe("2025-01-01 to 2025-06-03");
    expect(on("Where did I travel last year?")).toBe("2024-01-01 to 2025-06-03");
    expect(on("What did I start 3 months ago?")).toBe("2025-02-14 to 2025-04-15");
    expect(on("Where did I live two years ago?")).toBe("2023-01-01 to 2023-12-31");
    expect(on("What did I do in the past 3 months?")).toBe("2025-03-03 to 2025-06-03");
    expect(on("Where did I go last summer?")).toBe("2024-06-01 to 2024-08-31");
    expect(on("What was planned for the summer of 2025?")).toBe("2025-06-01 to 2025-08-31");
  });

  it("reads ranges and sides", () => {
    expect(on("What did I do between March and May?")).toBe("2025-03-01 to 2025-05-31");
    expect(on("What did I learn between 2025-01-10 and 2025-02-20?")).toBe(
      "2025-01-10 to 2025-02-20",
    );
    expect(on("What changed since April?")).toBe("2025-04-01 to 2025-06-03");
    expect(on("Where did I work before 2020?")).toBe("1900-01-01 to 2019-12-31");
    expect(on("What did I do after 2025-05-20?")).toBe("2025-05-21 to 2025-06-03");
  });

  it("reads Dutch", () => {
    expect(on("Wat heb ik gisteren gegeten?")).toBe("2025-06-02");
    expect(on("Wat deed ik vorige week?")).toBe("2025-05-26 to 2025-06-03");
    expect(on("Waar was ik in mei?")).toBe("2025-05-01 to 2025-05-31");
    expect(on("Wat kocht ik twee weken geleden?")).toBe("2025-05-16 to 2025-05-28");
    expect(on("Wat deed ik vorige maand?")).toBe("2025-05-01 to 2025-06-03");
  });

  it("does not take names and words for dates", () => {
    expect(on("What did I hear from Jan about the move?")).toBeNull();
    expect(on("May I ask what my favourite colour is?")).toBeNull();
    expect(on("What do I think of the march against cuts?")).toBeNull();
  });

  it("uses now when the question states no date", () => {
    const w = timeWindow("What did I do yesterday?", new Date("2025-01-01T10:00:00Z"));
    expect(w && describeWindow(w)).toBe("2024-12-31");
  });
});
