// usStandardResume.typ — 1-page ATS-optimized resume (SDD Requirement 3, default variant)
//
// PURPOSE
//   Renders a US-format, single-page resume in plain vertical text flow (no
//   images, no reordering tables) so that src/utils/atsChecker.ts extracts
//   section headings sequentially in its expected order: Experience, then
//   Education, then Skills.
//
// INPUT CONTRACT
//   Self-contained document. The single data source is the `profile` binding
//   inside the PROFILE DATA marker block below. The generate command (Step 5b)
//   rewrites that binding at compile time; nothing else in this file is meant
//   to be edited. Object shape mirrors the sections of `masterProfile.md` after
//   the init wizard (Requirement 1b / Step 9):
//
//     name           string             required
//     cityState      string             required, e.g. "Austin, TX" (never a street address)
//     email          string             required
//     phone          string             required
//     linkedIn       string             required or "" (public LinkedIn URL)
//     portfolio      string             optional, "" when absent
//     summary        string             optional professional summary
//     experience     array of {
//                      roleTitle, employer, location, startDate, endDate,
//                      bullets: array of strings
//                    }
//     skills         array of { category, items: array of strings }
//     education      array of { degree, institution, startYear, endYear }
//     certifications array of strings   optional
//
//   All field names are camelCase (no underscores) per SDD Section 2.1.
//
// US EEO COMPLIANCE FILTER (structural, per SDD Requirement 3)
//   The template renders ONLY the fields declared above. It carries no field,
//   parameter, or array key for photo, marital status, gender, age, birth date,
//   or a full residential street address anywhere in its expected input or
//   output. The guard below walks every nesting level of the received profile
//   and aborts compilation with a specific error if any forbidden key is
//   present — enforcement does not depend on the generator remembering to
//   filter; the template itself rejects the input. The contact block is limited
//   to Name, City/State, Email, Phone, LinkedIn, and Portfolio.

#set page(paper: "us-letter", margin: (x: 0.55in, y: 0.5in))
#set text(size: 9.5pt)
#set par(justify: false, leading: 1.2em)

// ==========================================================================
// EEO compliance guard (structural). US EEO practice excludes these personal
// identifiers from resumes (SDD Requirement 3).
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

// Collect a flat list of forbidden-key paths inside a dictionary/array graph.
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

// Compilation abort helper; a build with an EEO violation fails loudly.
#let guardEeoClean(p) = {
  let v = collectEeoViolations(p, "")
  if v.len() != 0 {
    panic(
      "usStandardResume.typ EEO compliance filter rejected field(s): " +
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

// Read only the allowed fields from the profile; ignores any excess keys.
// guardEeoClean throws if a banned EEO identifier is present at any depth.
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
  #v(0.6em)
  #text(size: 10.5pt, weight: "bold")[#name]
  #v(0.15em)
  #line(length: 100%, stroke: 0.5pt)
  #v(0.35em)
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

// ==========================================================================
// Document body. Reading order matches atsChecker default sections exactly:
// Experience -> Education -> Skills.
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
#for entry in p.experience {
  rowGrid(entry.roleTitle, entry.employer, dateRange(entry.startDate, entry.endDate))
  locationLine(entry.location)
  for b in entry.bullets {
    bulletBlock(b)
  }
  v(0.2em)
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