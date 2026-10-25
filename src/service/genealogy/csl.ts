/**
 * The default citation style: numbers in order of first citation, in square
 * brackets, and an NLM/Vancouver-type reference list. Written for
 * ResearchBunny; a report can name any other CSL file instead.
 */
export const VANCOUVER_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" demote-non-dropping-particle="sort-only" default-locale="en-US">
  <info>
    <title>ResearchBunny Vancouver (numeric, brackets)</title>
    <id>researchbunny-vancouver</id>
    <category citation-format="numeric"/>
    <updated>2026-10-25T00:00:00+00:00</updated>
  </info>
  <!-- Vancouver keeps English terms whatever the document language. -->
  <locale>
    <terms>
      <term name="et-al">et al.</term>
      <term name="in">in</term>
      <term name="editor" form="short"><single>ed.</single><multiple>eds.</multiple></term>
      <term name="editor"><single>editor</single><multiple>editors</multiple></term>
      <term name="page" form="short"><single>p.</single><multiple>pp.</multiple></term>
    </terms>
  </locale>
  <macro name="author">
    <names variable="author">
      <name initialize-with="" name-as-sort-order="all" sort-separator=" " delimiter=", " delimiter-precedes-last="always" et-al-min="7" et-al-use-first="6"/>
      <et-al prefix=" "/>
      <label form="short" prefix=", "/>
      <substitute>
        <names variable="editor"/>
      </substitute>
    </names>
  </macro>
  <macro name="title">
    <text variable="title"/>
  </macro>
  <macro name="container">
    <choose>
      <if type="article-journal article-magazine article-newspaper review" match="any">
        <group delimiter=" ">
          <text variable="container-title" form="short" strip-periods="true"/>
          <group delimiter=";">
            <date variable="issued"><date-part name="year"/></date>
            <group>
              <text variable="volume"/>
              <text variable="issue" prefix="(" suffix=")"/>
            </group>
          </group>
        </group>
        <text variable="page" prefix=":"/>
      </if>
      <else-if type="chapter paper-conference" match="any">
        <group delimiter=" ">
          <text term="in" text-case="capitalize-first" suffix=":"/>
          <names variable="editor">
            <name initialize-with="" name-as-sort-order="all" sort-separator=" " delimiter=", "/>
            <label form="long" prefix=", " suffix="."/>
          </names>
          <text variable="container-title" suffix="."/>
          <text variable="publisher-place" suffix=":"/>
          <group delimiter="; ">
            <text variable="publisher"/>
            <date variable="issued"><date-part name="year"/></date>
          </group>
        </group>
        <text variable="page" prefix=". p. "/>
      </else-if>
      <else>
        <group delimiter="; ">
          <group delimiter=": ">
            <text variable="publisher-place"/>
            <text variable="publisher"/>
          </group>
          <date variable="issued"><date-part name="year"/></date>
        </group>
      </else>
    </choose>
  </macro>
  <citation collapse="citation-number">
    <sort>
      <key variable="citation-number"/>
    </sort>
    <layout prefix="[" suffix="]" delimiter=", ">
      <group delimiter=", ">
        <text variable="citation-number"/>
        <group delimiter=" ">
          <label variable="locator" form="short"/>
          <text variable="locator"/>
        </group>
      </group>
    </layout>
  </citation>
  <bibliography second-field-align="flush" et-al-min="7" et-al-use-first="6">
    <layout suffix=".">
      <text variable="citation-number" suffix=". "/>
      <group delimiter=". ">
        <text macro="author"/>
        <text macro="title"/>
        <text macro="container"/>
      </group>
      <text variable="DOI" prefix=". doi:"/>
    </layout>
  </bibliography>
</style>
`;
