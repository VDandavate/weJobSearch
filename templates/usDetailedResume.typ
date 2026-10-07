// usDetailedResume.typ — Detailed ATS resume variant (SDD Requirement 3,
// resumeVariants.yaml `usDetailedResume`) for federal / GSE-style roles.
//
// PURPOSE
//   Same profile contract and same EEO filter as usStandardResume.typ, but the
//   Experience section renders each employer as its own standalone block with
//   every distinct role beneath it, matching how federal / government-sponsored
//   applications emphasize per-employer details. Reading order still matches
//   the atsChecker default section expectation: Experience -> Education ->
//   Skills.
//
// INPUT CONTRACT
//   Self-contained document. The single data source is the `profile` binding
//   inside the PROFILE DATA marker block below. The generate command (Step 5b)
//   rewrites that binding at compile time. Fields are identical to
//   usStandardResume.typ:
//
//     name           string
//     cityState      string
//     email          string
//     phone          string
//     linkedIn       string
//     portfolio      string             optional ""
//     summary        string             optional ""
//     experience     array of {
//                      roleTitle, employer, location, startDate, endDate,
//                      bullets: array of strings
//                    }
//     skills         array of { category, items: array of strings }
//     education      array of { degree, institution, startYear, endYear }
//     certifications array of strings   optional
//
//   (All camelCase per SDD Section 2.1.)
//
// US EEO COMPLIANCE FILTER (structural)
//   Same guarantee as usStandardResume.typ: no field, parameter, or array key
//   exists for photo, marital status, gender, age, birth date, or a full
//   residential street address. guardEeoClean() walks every nesting level and
//   aborts compilation listing any banned key, so the filter is structural —
//   it lives in the template, not in whoever calls it. The contact block is
//   limited to Name, City/State, Email, Phone, LinkedIn, and Portfolio.

#set page(paper: "us-letter", margin: (x: 0.6in, y: 0.55in))
#set text(size: 9.5pt)
#set par(justify: false, leading: 1.25em)

// ==========================================================================
// EEO compliance guard (structural). Shared with usStandardResume.typ.
// ==========================================================================

#let eeoForbiddenFields = (
  "photo",
  "headshot",
  "image",
  "photoPath",
  "profilePhoto",
  "gender",
  "sex",
  "maritalStatus",
  "marriageStatus",
  "spouseName",
  "age",
  "birthDate",
  "dateOfBirth",
  "birthYear",
  "yearOfBirth",
  "streetAddress",
  "streetAddressLine1",
  "streetAddressLine2",
  "residentialAddress",
  "homeAddress",
)

#let collectEeoViolations(value, path) = {
  let violations = ()
  if type(value) == type((a: 1)) {
    for (k, v) in value.pairs() {
      let kStr = k
      let fullPath = if path == "" { kStr } else { path + "." + kStr }
      if eeoForbiddenFields.contains(kStr) {
        violations = violations + (fullPath,)
      }
      violations = violations + collectEeoViolations(v, fullPath)
    }
  } else if type(value) == type(()) {
    for (idx, item) in value.enumerate() {
      violations = violations + collectEeoViolations(item, path + "[" + str(idx) + "]")
    }
  }
  violations
}

#let guardEeoClean(p) = {
  let v = collectEeoViolations(p, "")
  if v.len() != 0 {
    panic(
      "usDetailedResume.typ EEO compliance filter rejected field(s): " +
      v.join(", ") +
      ". Resumes may carry only Name, City/State, Email, Phone, LinkedIn, and " +
      "Portfolio as contact data. Photo, marital status, gender, age, birth date, " +
      "and residential street address are prohibited.",
    )
  }
  p
}

// ==========================================================================
// PROFILE DATA — Step 5b `generate` rewrites this binding (and nothing else).
// Seam markers: replace everything between BEGIN_PROFILE and END_PROFILE with
// `#let profile = (...)`, keeping BEGIN_PROFILE/END_PROFILE comments intact.
// ==========================================================================

// BEGIN_PROFILE
#let profile = (
  name: "REPLACE_ME",
  cityState: "REPLACE_ME",
  email: "REPLACE_ME",
  phone: "REPLACE_ME",
  linkedIn: "REPLACE_ME",
  portfolio: "",
  summary: "",
  experience: (
    (
      roleTitle: "REPLACE_ME",
      employer: "REPLACE_ME",
      location: "REPLACE_ME",
      startDate: "REPLACE_ME",
      endDate: "REPLACE_ME",
      bullets: ("REPLACE_ME",),
    ),
  ),
  skills: (
    (category: "REPLACE_ME", items: ("REPLACE_ME",)),
  ),
  education: (
    (degree: "REPLACE_ME", institution: "REPLACE_ME", startYear: "REPLACE_ME", endYear: "REPLACE_ME"),
  ),
  certifications: (),
)
// END_PROFILE

#let p = guardEeoClean(profile)

// ==========================================================================
// Rendering helpers.
// ==========================================================================

#let dateRange(start, end) = {
  if end == "Present" {
    start
  } else {
    start + " - " + end
  }
}

#let contactLine(p) = {
  let parts = ()
  let known = ("cityState", "email", "phone", "linkedIn", "portfolio")
  for (k, v) in p.pairs() {
    if known.contains(k) and v != "" {
      parts = parts + (v,)
    }
  }
  parts.join("   |   ")
}

#let headingBlock(name) = [
  #v(0.7em)
  #text(size: 11pt, weight: "bold")[#name]
  #v(0.15em)
  #line(length: 100%, stroke: 0.6pt)
  #v(0.4em)
]

#let employerHeading(name) = [
  #v(0.55em)
  #text(size: 10.5pt, weight: "bold")[#name]
  #v(0.1em)
  #line(length: 100%, stroke: 0.3pt)
  #v(0.3em)
]

#let bulletBlock(item) = [
  • #item
]

#let rowGrid(label, secondary, dates) = [
  #grid(
    columns: (1fr, auto),
    align: (left, right),
    [
      #text(weight: "bold")[#label]
      #if secondary != "" [
        #text(weight: "regular")[  (#secondary)]
      ]
    ],
    [#text(weight: "regular")[#dates]],
  )
  #v(0.1em)
]

#let locationLine(location) = {
  if location == "" {
    []
  } else {
    [
      #text(style: "italic")[#location]
      #v(0.1em)
    ]
  }
}

#let skillsRow(category, items) = {
  let joined = items.join(", ")
  if category == "" {
    [
      #joined
    ]
  } else {
    [
      #text(weight: "bold")[#category]: #joined
    ]
  }
}

// Group experience entries into standalone per-employer blocks, preserving
// first-appearance order.
#let groupByExperience(exper) = {
  let groups = ()
  for entry in exper {
    let found = none
    for (gi, g) in groups.enumerate() {
      if g.key == entry.employer {
        found = gi
      }
    }
    if found == none {
      groups = groups + ((key: entry.employer, entries: (entry,)),)
    } else {
      let updated = ()
      for (gi, g) in groups.enumerate() {
        if gi == found {
          updated = updated + ((key: entry.employer, entries: g.entries + (entry,)),)
        } else {
          updated = updated + (g,)
        }
      }
      groups = updated
    }
  }
  groups
}

// ==========================================================================
// Document body. Reading order: Experience -> Education -> Skills.
// ==========================================================================

#align(center)[
  #text(size: 16pt, weight: "bold")[#p.name]
  #if p.cityState != "" {
    v(2pt)
    text(size: 9.5pt)[#p.cityState]
  }
  #v(2pt)
  #text(size: 9.5pt)[#contactLine(p)]
]

#if p.summary != "" {
  headingBlock("Summary")
  p.summary
}

#headingBlock("Experience")
#for group in groupByExperience(p.experience) {
  employerHeading(group.key)
  for entry in group.entries {
    rowGrid(entry.roleTitle, entry.location, dateRange(entry.startDate, entry.endDate))
    for b in entry.bullets {
      bulletBlock(b)
    }
    v(0.25em)
  }
}

#headingBlock("Education")
#for edu in p.education {
  rowGrid(edu.degree, edu.institution, dateRange(edu.startYear, edu.endYear))
}

#headingBlock("Skills")
#for skill in p.skills {
  skillsRow(skill.category, skill.items)
}

#if p.certifications.len() > 0 {
  headingBlock("Certifications")
  for cert in p.certifications {
    bulletBlock(cert)
  }
}