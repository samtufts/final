import csv
import json
from Levenshtein import distance as LD

def readGeneralHospitalDatabase():
	columns = []
	data = []
	zipmap = {}
	
	# read the CSV file into columns and data arrays
	with open("Hospital_General_Information.csv") as csvfile:
		reader = csv.reader(csvfile)
		for lineNumber, row in enumerate(reader):
			if lineNumber == 0:
				for columnName in row:
					columns.append(columnName)
			else:
				rowData = {}
				for colIndex, value in enumerate(row):
					rowData[columns[colIndex]] = value
				data.append(rowData)

	# hash the same zip codes together
	for row in data:
		zipcode = row["ZIP Code"]
		if len(zipcode) == 4:
			row["ZIP Code"] = "0" + zipcode
			zipcode = row["ZIP Code"]
		if zipcode not in zipmap:
			zipmap[zipcode] = []
		zipmap[zipcode].append(row)

	return (columns, data, zipmap)

def readJSONDatabase():
	data = None	
	with open("hospitaldb.json", encoding="utf-8") as jsonfile:
		data = json.load(jsonfile)
	
	if data == None:
		return None, None

	zipmap = {}

	for hospital in data["features"]:
		prop = hospital["properties"]
		if prop["ZIP"] not in zipmap:
			zipmap[prop["ZIP"]] = []
		zipmap[prop["ZIP"]].append(prop)

	return data, zipmap

def fillName(hospital_prop, csv_row):
	hospital_prop["GRABBED_PHONE_NUMBER"] = csv_row["Phone Number"]

if __name__ == "__main__":
	
	# columns and data represent the information in the hospital CSV
	# file that contains the phone numbers we're interested in.  we're
	# going to attempt to map each phone number to a corresponding 
	# entry in our JSON hospital file
	columns, data, csvzipmap = readGeneralHospitalDatabase()

	# jsondb is a Python-dictionary representation of our JSON hospital data
	jsondb, jsonzipmap = readJSONDatabase()

	# the zipmaps are hashtables that classify each entry by
	# their zipcodes, which greatly reduces runtime (reduced
	# runtime from O(n^2) to O(n), since each zipmap entry
	# is strictly 4 elements or less, based on observation)
	# for example, zipmap[ZIP_CODE] = {hospital0, hospital1, ...}
	
	# array of tuples of matches we've found
	matches = []

	hospitals = jsondb["features"]
	
	# maps a hospital entry in the CSV file (which contains phone numbers)
	# to an entry in the JSON file, which is the file that our Heroku server
	# uses to determine nearest hospitals.  The JSON file does not contain
	# phone numbers, so we're going to grab it from this CSV file.
	#
	# The two databases do not represent the addresses in the same way.  E.g.,
	# one database may say 'Road' while the other says 'Rd.'.  Thus, we need some
	# dynamic way to find two matching hospitals given that they have the same zip
	# code.  Here, Levenshtein's Distance Algorithm is used to determine matching
	# entries given a large collection of them.
	for key in csvzipmap:
		csv_hosps = csvzipmap[key]
		if key in jsonzipmap:
			json_hosps = jsonzipmap[key]
			if len(csv_hosps) == 1 and len(json_hosps) == 1:
				matches.append((csv_hosps[0], json_hosps[0]))
			else:
				ldcost = [[0 for _ in range(len(json_hosps))] for _ in range(len(csv_hosps))]
				for i, csvh in enumerate(csv_hosps):
					for j, jsonh in enumerate(json_hosps):
						ldcost[i][j] = LD(csvh["Address"].lower(), jsonh["ADDRESS"].lower())
				for i, csvh in enumerate(csv_hosps):
					min_json_index = ldcost[i].index(min(ldcost[i]))
					matches.append((csvh, json_hosps[min_json_index]))
	
	# steal the matches from this CSV file! >:-)
	for match in matches:
		match[1]["GRABBED_PHONE_NUMBER"] = match[0]["Phone Number"]

	for jsonh in hospitals:
		if "GRABBED_PHONE_NUMBER" not in jsonh["properties"]:
			jsonh["properties"]["GRABBED_PHONE_NUMBER"] = "Unavailable"

	with open("parsed.json", "w") as fp:
		json.dump(jsondb, fp, indent=2, sort_keys=True)
